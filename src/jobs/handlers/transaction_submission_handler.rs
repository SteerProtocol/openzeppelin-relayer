//! Transaction submission handler for processing submission jobs.
//!
//! Handles the submission of prepared transactions to networks:
//! - Submits transactions to appropriate networks
//! - Handles different submission commands (Submit, Cancel, Resubmit)
//! - Updates transaction status after submission
//! - Enqueues status monitoring jobs
use actix_web::web::ThinData;
use chrono::Utc;
use eyre::Result;
use tracing::{debug, info, instrument, warn};

use crate::{
    constants::{
        WORKER_TRANSACTION_CANCEL_RETRIES, WORKER_TRANSACTION_RESEND_RETRIES,
        WORKER_TRANSACTION_RESUBMIT_RETRIES, WORKER_TRANSACTION_SUBMIT_RETRIES,
    },
    domain::{get_relayer_transaction, get_transaction_by_id, is_final_state, Transaction},
    jobs::{handle_result, Job, JobProducerTrait, TransactionCommand, TransactionSend},
    metrics::{observe_processing_time, STAGE_SUBMISSION_QUEUE_DWELL, STAGE_SUBMIT_DURATION},
    models::{DefaultAppState, RepositoryError, TransactionRepoModel, TransactionStatus},
    observability::request_id::set_request_id,
    queues::{redis::submission_control, HandlerError, WorkerContext},
    repositories::TransactionRepository,
};

#[instrument(
    level = "info",
    skip(job, state, ctx),
    fields(
        request_id = ?job.request_id,
        job_id = %job.message_id,
        job_type = %job.job_type.to_string(),
        attempt = %ctx.attempt,
        tx_id = %job.data.transaction_id,
        relayer_id = %job.data.relayer_id,
        task_id = %ctx.task_id,
        command = ?job.data.command,
    )
)]
pub async fn transaction_submission_handler(
    job: Job<TransactionSend>,
    state: ThinData<DefaultAppState>,
    ctx: WorkerContext,
) -> Result<(), HandlerError> {
    if let Some(request_id) = job.request_id.clone() {
        set_request_id(request_id);
    }

    debug!(
        tx_id = %job.data.transaction_id,
        relayer_id = %job.data.relayer_id,
        "handling transaction submission"
    );

    let command = job.data.command.clone();
    let job_timestamp = job.timestamp.clone();
    let submission = job.data.clone();
    info!(
        tx_id = %submission.transaction_id,
        relayer_id = %submission.relayer_id,
        task_id = %ctx.task_id,
        "submission job picked up"
    );
    if submission_control::applies(&submission) {
        if let Some(queue) = state
            .job_producer
            .get_queue_backend()
            .and_then(|b| b.queue().cloned())
        {
            let (owner, blocked) = submission_control::reservation_state(
                &queue.transaction_submission_queue,
                &submission,
            )
            .await
            .map_err(|e| HandlerError::Retry(e.to_string()))?;
            if let Some(reason) = blocked {
                persist_automatic_submission_failure(
                    &*state.transaction_repository(),
                    &submission.transaction_id,
                    &reason,
                )
                .await
                .map_err(|e| HandlerError::Retry(e.to_string()))?;
                return Err(HandlerError::Abort(format!(
                    "Automatic submission failed: {reason}; nonce requires reconciliation"
                )));
            }
            if !owns_submission_reservation(&submission, &ctx.task_id, owner.as_deref()) {
                return Err(HandlerError::Abort(
                    "Stale submission delivery no longer owns its reservation".into(),
                ));
            }
        }
    }
    let mut result = handle_request(job.data, &state, &job_timestamp).await;

    // Only guarded messages carry the owning Apalis task ID. Legacy messages
    // cannot release a newer reservation, and non-Redis backends are untouched.
    if submission
        .metadata
        .as_ref()
        .and_then(|m| m.get(submission_control::OWNER_METADATA))
        == Some(&ctx.task_id)
    {
        if let Some(queue) = state
            .job_producer
            .get_queue_backend()
            .and_then(|b| b.queue().cloned())
        {
            let progress = matches!(&result, Ok(true));
            let permanent = result.as_ref().err().is_some_and(|e| {
                e.to_string()
                    .to_lowercase()
                    .contains("intrinsic gas too low")
            });
            match submission_control::finish(
                &queue.transaction_submission_queue,
                &submission,
                &ctx.task_id,
                progress,
                permanent,
            )
            .await
            {
                Ok(true) => {
                    let reason = result
                        .as_ref()
                        .err()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| {
                            "retry budget exhausted without submission progress".to_string()
                        });
                    // Persist terminal status before ending the job. A repository
                    // failure retries this delivery; its blocked control prevents
                    // another broadcast on that retry.
                    persist_automatic_submission_failure(
                        &*state.transaction_repository(),
                        &submission.transaction_id,
                        &reason,
                    )
                    .await
                    .map_err(|e| HandlerError::Retry(e.to_string()))?;
                    return Err(HandlerError::Abort(format!(
                        "Automatic submission failed: {reason}; nonce requires reconciliation"
                    )));
                }
                Ok(false) => {}
                Err(error) => {
                    // Enqueue recovers this reservation from the durable ACK.
                    warn!(tx_id = %submission.transaction_id, %error, "submission completion control update failed");
                }
            }
        }
        result = require_submission_progress(result);
        // finish released this delivery's reservation. End this job; only a
        // fresh status-driven job may retry after the shared cooldown. Retrying
        // this old Apalis delivery could race a newly reserved owner.
        return result
            .map(|_| ())
            .map_err(|e| HandlerError::Abort(e.to_string()));
    }

    if submission_control::applies(&submission)
        && result.is_err()
        && (ctx.attempt >= get_max_retries(&command)
            || result.as_ref().err().is_some_and(|e| {
                e.to_string()
                    .to_lowercase()
                    .contains("intrinsic gas too low")
            }))
    {
        let reason = result.as_ref().unwrap_err().to_string();
        persist_automatic_submission_failure(
            &*state.transaction_repository(),
            &submission.transaction_id,
            &reason,
        )
        .await
        .map_err(|e| HandlerError::Retry(e.to_string()))?;
        return Err(HandlerError::Abort(reason));
    }

    // Handle result with command-specific retry logic
    handle_result(
        result.map(|_| ()),
        &ctx,
        "Transaction Submission",
        get_max_retries(&command),
    )
}

/// End automatic recovery without changing intent, signatures, hashes or nonce.
/// Repository guards keep a concurrent mined/final result authoritative.
pub async fn persist_automatic_submission_failure<TR: TransactionRepository + Send + Sync>(
    repository: &TR,
    transaction_id: &str,
    reason: &str,
) -> Result<TransactionRepoModel, RepositoryError> {
    repository
        .partial_update(
            transaction_id.to_string(),
            TransactionRepoModel::automatic_submission_failure(reason),
        )
        .await
}

/// Reject old/crashed deliveries once a fresh task owns automatic recovery.
/// Legacy jobs can execute only when no guarded reservation is present.
pub fn owns_submission_reservation(
    job: &TransactionSend,
    task_id: &str,
    owner: Option<&str>,
) -> bool {
    match job
        .metadata
        .as_ref()
        .and_then(|m| m.get(submission_control::OWNER_METADATA))
    {
        Some(expected) => expected == task_id && owner == Some(task_id),
        None => owner.is_none(),
    }
}

/// Only definite fee rejections permit an immediate same-nonce replacement.
pub fn is_fee_repricing_error(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "max fee per gas less than block base fee",
        "fee cap less than block base fee",
        "gas price too low",
        "transaction underpriced",
    ]
    .iter()
    .any(|pattern| message.contains(pattern))
}

fn require_submission_progress(result: Result<bool>) -> Result<bool> {
    match result {
        Ok(false) => Err(eyre::eyre!(
            "Submission failed: no broadcast or transaction progress"
        )),
        outcome => outcome,
    }
}

/// Get max retry count based on command type
fn get_max_retries(command: &TransactionCommand) -> usize {
    match command {
        TransactionCommand::Submit => WORKER_TRANSACTION_SUBMIT_RETRIES,
        TransactionCommand::Resubmit => WORKER_TRANSACTION_RESUBMIT_RETRIES,
        TransactionCommand::Cancel { .. } => WORKER_TRANSACTION_CANCEL_RETRIES,
        TransactionCommand::Resend => WORKER_TRANSACTION_RESEND_RETRIES,
    }
}

async fn handle_request(
    status_request: TransactionSend,
    state: &ThinData<DefaultAppState>,
    job_timestamp: &str,
) -> Result<bool> {
    let relayer_transaction =
        get_relayer_transaction(status_request.relayer_id.clone(), state).await?;

    let transaction = get_transaction_by_id(status_request.transaction_id, state).await?;

    if is_final_state(&transaction.status) || transaction.status == TransactionStatus::Mined {
        return Ok(true);
    }

    // Capture transaction info for completion log
    let tx_id = transaction.id.clone();
    let relayer_id = transaction.relayer_id.clone();
    let network_type = transaction.network_type.to_string();
    let command = status_request.command.clone();

    // Measure submission queue dwell time using the Job's creation timestamp.
    // This is the time between when the submit job was enqueued (after prepare)
    // and when this handler starts processing it.
    if let Ok(enqueued_epoch) = job_timestamp.parse::<i64>() {
        let now_ms = Utc::now().timestamp_millis();
        let enqueued_ms = enqueued_epoch * 1000; // Job.timestamp is whole seconds
        let dwell_secs = (now_ms - enqueued_ms).max(0) as f64 / 1000.0;
        observe_processing_time(
            &relayer_id,
            &network_type,
            STAGE_SUBMISSION_QUEUE_DWELL,
            dwell_secs,
        );
    }

    debug!(
        tx_id = %transaction.id,
        relayer_id = %transaction.relayer_id,
        status = ?transaction.status,
        "loaded transaction for submission"
    );

    let submit_start = std::time::Instant::now();
    let previous = transaction.clone();

    let updated = match status_request.command {
        TransactionCommand::Submit | TransactionCommand::Resend => {
            match relayer_transaction
                .submit_transaction(transaction.clone())
                .await
            {
                Ok(updated) => updated,
                Err(error) if is_fee_repricing_error(&error.to_string()) => {
                    // A definite fee rejection can be repriced immediately using
                    // the same intent and nonce. Timeouts and unknown outcomes
                    // never enter this path.
                    relayer_transaction
                        .resubmit_transaction(transaction)
                        .await?
                }
                Err(error) => return Err(error.into()),
            }
        }
        TransactionCommand::Cancel { reason } => {
            info!(
                tx_id = %tx_id,
                relayer_id = %relayer_id,
                status_reason = %reason,
                "cancelling transaction"
            );
            relayer_transaction.submit_transaction(transaction).await?
        }
        TransactionCommand::Resubmit => {
            debug!(
                tx_id = %tx_id,
                relayer_id = %relayer_id,
                "resubmitting transaction with updated parameters"
            );
            relayer_transaction
                .resubmit_transaction(transaction)
                .await?
        }
    };

    let submit_duration = submit_start.elapsed().as_secs_f64();
    observe_processing_time(
        &relayer_id,
        &network_type,
        STAGE_SUBMIT_DURATION,
        submit_duration,
    );

    debug!(
        tx_id = %tx_id,
        relayer_id = %relayer_id,
        command = ?command,
        submit_duration_ms = submit_start.elapsed().as_millis(),
        "transaction submission completed"
    );

    Ok(made_submission_progress(&previous, &updated))
}

fn made_submission_progress(before: &TransactionRepoModel, after: &TransactionRepoModel) -> bool {
    // Nonce-too-high can return Ok without changing a Sent OR Submitted record.
    // Neither is progress; otherwise already-Submitted records bypass the budget.
    if matches!(
        after.status,
        TransactionStatus::Pending | TransactionStatus::Sent
    ) {
        return false;
    }
    after.status != before.status
        || after.hashes != before.hashes
        || after.sent_at != before.sent_at
        || !matches!(after.status, TransactionStatus::Submitted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn unsuccessful_submission_is_not_acknowledged_as_success() {
        let outcome = require_submission_progress(Ok(false));
        assert!(outcome
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("no broadcast"));
        let handled = handle_result(
            outcome.map(|_| ()),
            &WorkerContext::new(0, "task".into()),
            "Transaction Submission",
            0,
        );
        assert!(matches!(handled, Err(HandlerError::Abort(_))));
        assert!(require_submission_progress(Ok(true)).is_ok());
        assert!(
            require_submission_progress(Err(eyre::eyre!("intrinsic gas too low")))
                .unwrap_err()
                .to_string()
                .contains("intrinsic gas too low")
        );
    }

    #[test]
    fn unchanged_submitted_or_sent_transactions_consume_recovery_budget() {
        use crate::domain::transaction::evm::test_helpers::test_utils::make_test_transaction;
        for status in [TransactionStatus::Sent, TransactionStatus::Submitted] {
            let before = make_test_transaction(status);
            let mut after = before.clone();
            after.status_reason = Some("Nonce too high (attempt 600)".to_string());
            assert!(!made_submission_progress(&before, &after));
        }
    }

    #[test]
    fn broadcast_or_confirmation_resets_recovery_budget() {
        use crate::domain::transaction::evm::test_helpers::test_utils::make_test_transaction;
        let before = make_test_transaction(TransactionStatus::Submitted);
        let mut after = before.clone();
        after.hashes.push("replacement-hash".to_string());
        assert!(made_submission_progress(&before, &after));
        after = before.clone();
        after.sent_at = Some("2026-10-13T14:00:00Z".to_string());
        assert!(made_submission_progress(&before, &after));
        after = before.clone();
        after.status = TransactionStatus::Confirmed;
        assert!(made_submission_progress(&before, &after));
    }

    #[tokio::test]
    async fn test_submission_handler_job_validation() {
        // Create a job with Submit command
        let submit_job = TransactionSend::submit("tx123", "relayer-1");
        let job = Job::new(crate::jobs::JobType::TransactionSend, submit_job);

        // Validate the job data
        match job.data.command {
            TransactionCommand::Submit => {}
            _ => panic!("Expected Submit command"),
        }
        assert_eq!(job.data.transaction_id, "tx123");
        assert_eq!(job.data.relayer_id, "relayer-1");
        assert!(job.data.metadata.is_none());

        // Create a job with Cancel command
        let cancel_job = TransactionSend::cancel("tx123", "relayer-1", "user requested");
        let job = Job::new(crate::jobs::JobType::TransactionSend, cancel_job);

        // Validate the job data
        match job.data.command {
            TransactionCommand::Cancel { reason } => {
                assert_eq!(reason, "user requested");
            }
            _ => panic!("Expected Cancel command"),
        }
    }

    #[tokio::test]
    async fn test_submission_job_with_metadata() {
        // Create a job with metadata
        let mut metadata = HashMap::new();
        metadata.insert("gas_price".to_string(), "20000000000".to_string());

        let submit_job =
            TransactionSend::submit("tx123", "relayer-1").with_metadata(metadata.clone());

        // Validate the metadata
        assert!(submit_job.metadata.is_some());
        let job_metadata = submit_job.metadata.unwrap();
        assert_eq!(job_metadata.get("gas_price").unwrap(), "20000000000");
    }

    mod get_max_retries_tests {
        use super::*;

        #[test]
        fn test_submit_command_retries() {
            let command = TransactionCommand::Submit;
            let retries = get_max_retries(&command);

            assert_eq!(
                retries, WORKER_TRANSACTION_SUBMIT_RETRIES,
                "Submit command should use WORKER_TRANSACTION_SUBMIT_RETRIES"
            );
        }

        #[test]
        fn test_resubmit_command_retries() {
            let command = TransactionCommand::Resubmit;
            let retries = get_max_retries(&command);

            assert_eq!(
                retries, WORKER_TRANSACTION_RESUBMIT_RETRIES,
                "Resubmit command should use WORKER_TRANSACTION_RESUBMIT_RETRIES"
            );
        }

        #[test]
        fn test_cancel_command_retries() {
            let command = TransactionCommand::Cancel {
                reason: "test cancel".to_string(),
            };
            let retries = get_max_retries(&command);

            assert_eq!(
                retries, WORKER_TRANSACTION_CANCEL_RETRIES,
                "Cancel command should use WORKER_TRANSACTION_CANCEL_RETRIES"
            );
        }

        #[test]
        fn test_resend_command_retries() {
            let command = TransactionCommand::Resend;
            let retries = get_max_retries(&command);

            assert_eq!(
                retries, WORKER_TRANSACTION_RESEND_RETRIES,
                "Resend command should use WORKER_TRANSACTION_RESEND_RETRIES"
            );
        }
    }
}
