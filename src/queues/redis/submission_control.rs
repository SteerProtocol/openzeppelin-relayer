//! Atomic reservation and bounded recovery for automatic EVM submissions.
//!
//! A reservation spans queued and executing work. Apalis owns crash recovery;
//! there is no lease timeout that can create a second concurrent submission.
use apalis::prelude::Request;
use apalis_redis::RedisContext;
use tracing::{debug, warn};

use crate::{
    jobs::{Job, TransactionSend},
    models::NetworkType,
    queues::{redis::queue::QueueStorage, QueueBackendError},
};

pub(crate) const OWNER_METADATA: &str = "redis_submission_owner";

/// Explicit cancellation keeps its existing path. Only newly produced EVM
/// messages opt in; legacy queued jobs and other networks remain compatible.
pub(crate) fn applies(job: &TransactionSend) -> bool {
    matches!(job.network_type, Some(NetworkType::Evm)) && !job.is_explicit_cancellation()
}

fn control_key(storage: &QueueStorage<Job<TransactionSend>>, job: &TransactionSend) -> String {
    format!(
        "{}:submission-control:{}:{}",
        storage.get_config().job_data_hash(),
        job.relayer_id,
        job.transaction_id
    )
}

pub(crate) async fn enqueue(
    storage: &QueueStorage<Job<TransactionSend>>,
    job: Job<TransactionSend>,
    scheduled_on: Option<i64>,
) -> Result<String, QueueBackendError> {
    let mut request: Request<_, RedisContext> = Request::new(job);
    let task_id = request.parts.task_id.to_string();
    request
        .args
        .data
        .metadata
        .get_or_insert_with(Default::default)
        .insert(OWNER_METADATA.to_string(), task_id.clone());
    let payload =
        serde_json::to_vec(&request).map_err(|e| QueueBackendError::RedisError(e.to_string()))?;
    let config = storage.get_config();
    let mut connection = storage.get_connection().clone();
    let (decision, owner, reason): (i64, String, String) =
        redis::Script::new(include_str!("scripts/enqueue_submission.lua"))
            .key(config.job_data_hash())
            .key(config.active_jobs_list())
            .key(config.signal_list())
            .key(config.scheduled_jobs_set())
            .key(control_key(storage, &request.args.data))
            .key(config.done_jobs_set())
            .key(config.dead_jobs_set())
            .arg(&task_id)
            .arg(payload)
            .arg(scheduled_on.map(|v| v.to_string()).unwrap_or_default())
            .invoke_async(&mut connection)
            .await
            .map_err(|e| QueueBackendError::RedisError(e.to_string()))?;
    crate::metrics::SUBMISSION_CONTROL_DECISIONS
        .with_label_values(&[
            request.args.data.relayer_id.as_str(),
            if decision == 1 {
                "enqueued"
            } else if decision == 0 {
                "suppressed"
            } else {
                "blocked"
            },
            reason.as_str(),
        ])
        .inc();
    debug!(
        relayer_id = %request.args.data.relayer_id,
        tx_id = %request.args.data.transaction_id,
        decision,
        reason,
        "submission enqueue decision"
    );
    enqueue_result(decision, owner, task_id, &reason)
}

fn enqueue_result(
    decision: i64,
    owner: String,
    task_id: String,
    reason: &str,
) -> Result<String, QueueBackendError> {
    if decision < 0 {
        return Err(QueueBackendError::QueueError(format!(
            "Automatic submission failed: {reason}; transaction nonce requires reconciliation"
        )));
    }
    // Coalesce existing work and cooldown ticks, but never acknowledge a
    // permanently failed submission as successfully scheduled.
    Ok(if owner.is_empty() { task_id } else { owner })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_submission_decisions_return_failure_instead_of_success() {
        for reason in ["intrinsic_gas_too_low", "retry_budget_exhausted"] {
            let error = enqueue_result(-1, String::new(), "new".into(), reason).unwrap_err();
            assert!(error.to_string().contains(reason));
        }
        assert_eq!(
            enqueue_result(0, "existing".into(), "new".into(), "queued_or_running").unwrap(),
            "existing"
        );
        assert!(enqueue_result(1, "new".into(), "new".into(), "enqueued").is_ok());
    }

    #[test]
    fn automatic_evm_commands_share_control_but_cancellation_does_not() {
        for job in [
            TransactionSend::submit("tx", "relayer"),
            TransactionSend::resubmit("tx", "relayer"),
            TransactionSend::resend("tx", "relayer"),
        ] {
            assert!(applies(&job.with_network_type(NetworkType::Evm)));
        }
        assert!(!applies(
            &TransactionSend::cancel("tx", "relayer", "operator")
                .with_network_type(NetworkType::Evm)
        ));
        assert!(!applies(
            &TransactionSend::cancellation_resubmit("tx", "relayer")
                .with_network_type(NetworkType::Evm)
        ));
    }

    #[test]
    fn legacy_and_other_network_jobs_keep_existing_behavior() {
        assert!(!applies(&TransactionSend::resubmit("tx", "relayer")));
        assert!(!applies(
            &TransactionSend::resubmit("tx", "relayer").with_network_type(NetworkType::Stellar)
        ));
    }
}

pub(crate) async fn finish(
    storage: &QueueStorage<Job<TransactionSend>>,
    job: &TransactionSend,
    task_id: &str,
    progress: bool,
    permanent: bool,
) -> Result<bool, QueueBackendError> {
    let outcome = if permanent {
        "permanent"
    } else if progress {
        "progress"
    } else {
        "retryable"
    };
    let mut connection = storage.get_connection().clone();
    let changed: i64 = redis::Script::new(include_str!("scripts/finish_submission.lua"))
        .key(control_key(storage, job))
        .arg(task_id)
        .arg(outcome)
        .arg("intrinsic_gas_too_low")
        .invoke_async(&mut connection)
        .await
        .map_err(|e| QueueBackendError::RedisError(e.to_string()))?;
    if changed == 2 {
        warn!(
            relayer_id = %job.relayer_id,
            tx_id = %job.transaction_id,
            permanent,
            "automatic submission failed; worker job ends and nonce requires reconciliation"
        );
    }
    Ok(changed == 2)
}

/// A blocked control is durable. Retried deliveries must finalize the record
/// without entering the signer/provider path again.
pub(crate) async fn blocked_reason(
    storage: &QueueStorage<Job<TransactionSend>>,
    job: &TransactionSend,
) -> Result<Option<String>, QueueBackendError> {
    use redis::AsyncCommands;
    let mut connection = storage.get_connection().clone();
    connection
        .hget(control_key(storage, job), "blocked")
        .await
        .map_err(|e| QueueBackendError::RedisError(e.to_string()))
}
