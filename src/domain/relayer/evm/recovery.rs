//! Bounded, receipt-only recovery for automatically paused EVM signers.
//! No signing, nonce rewinds, cancellation, replacement or replay is allowed here.
use super::EvmRelayer;
use crate::{
    jobs::{JobProducerTrait, RelayerHealthCheck},
    models::{NetworkRepoModel, RelayerError, RelayerRepoModel, TransactionRepoModel},
    repositories::{NetworkRepository, RelayerRepository, Repository, TransactionRepository},
    services::{
        provider::EvmProviderTrait, signer::DataSignerTrait, TransactionCounterServiceTrait,
    },
    utils::calculate_scheduled_timestamp,
};
use chrono::{TimeZone, Utc};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};
use tracing::{info, warn};

pub(crate) const RECOVERY_ACTION: &str = "nonce_receipt_recovery";
const BATCH_SIZE: usize = 8;
const INTERVAL_SECS: i64 = 60;
static LOCAL_GATE: OnceLock<DashMap<String, Instant>> = OnceLock::new();

fn hex_u64(value: &Value) -> Option<u64> {
    u64::from_str_radix(value.as_str()?.strip_prefix("0x")?, 16).ok()
}
fn same_hex(a: &Value, b: &str) -> bool {
    a.as_str().is_some_and(|a| a.eq_ignore_ascii_case(b))
}

/// Bind a known signed hash to the expected signer/nonce and canonical block.
/// Success AND revert receipts must have the configured confirmation depth.
fn prove_receipt(
    tx: &TransactionRepoModel,
    hash: &str,
    receipt: &Value,
    mined: &Value,
    block: &Value,
    tip: u64,
    confirmations: u64,
) -> Option<(bool, String)> {
    let data = tx.network_data.get_evm_transaction_data().ok()?;
    let nonce = data.nonce?;
    let height = hex_u64(&receipt["blockNumber"])?;
    let block_hash = block["hash"].as_str()?;
    if !same_hex(&receipt["transactionHash"], hash)
        || !same_hex(&mined["hash"], hash)
        || !same_hex(&receipt["from"], &data.from)
        || !same_hex(&mined["from"], &data.from)
        || hex_u64(&mined["nonce"]) != Some(nonce)
        || hex_u64(&mined["chainId"]) != Some(data.chain_id)
        || mined["input"].as_str().unwrap_or("0x").to_lowercase()
            != data
                .data
                .clone()
                .unwrap_or_else(|| "0x".into())
                .to_lowercase()
        || mined["value"].as_str().and_then(|v| {
            alloy::primitives::U256::from_str_radix(v.trim_start_matches("0x"), 16).ok()
        }) != Some(data.value)
        || !same_hex(&receipt["blockHash"], block_hash)
        || !same_hex(&mined["blockHash"], block_hash)
        || hex_u64(&block["number"]) != Some(height)
        || tip < height
        || tip - height < confirmations
    {
        return None;
    }
    match &data.to {
        Some(to) if !same_hex(&receipt["to"], to) || !same_hex(&mined["to"], to) => return None,
        None if !receipt["to"].is_null() || !mined["to"].is_null() => return None,
        _ => {}
    }
    let status = hex_u64(&receipt["status"])?;
    if status > 1 {
        return None;
    }
    let timestamp = i64::try_from(hex_u64(&block["timestamp"])?).ok()?;
    Some((
        status == 1,
        Utc.timestamp_opt(timestamp, 0).single()?.to_rfc3339(),
    ))
}

impl<P, RR, NR, TR, J, S, TCS> EvmRelayer<P, RR, NR, TR, J, S, TCS>
where
    P: EvmProviderTrait + Send + Sync,
    RR: Repository<RelayerRepoModel, String> + RelayerRepository + Send + Sync + 'static,
    NR: NetworkRepository + Repository<NetworkRepoModel, String> + Send + Sync + 'static,
    TR: Repository<TransactionRepoModel, String> + TransactionRepository + Send + Sync + 'static,
    J: JobProducerTrait + Send + Sync + 'static,
    S: DataSignerTrait + Send + Sync + 'static,
    TCS: TransactionCounterServiceTrait + Send + Sync + 'static,
{
    /// Runs only for durable automatic provenance; legacy/manual pauses are untouched.
    pub(crate) async fn recover_nonce_hold(&self) -> Result<(), RelayerError> {
        let live = self
            .relayer_repository
            .get_by_id(self.relayer.id.clone())
            .await?;
        let Some(token) = live.nonce_recovery_hold.clone().filter(|_| live.paused) else {
            return Ok(());
        };
        let claim = uuid::Uuid::new_v4().to_string();
        // A fixed cooldown rather than an unlock-on-return lease bounds repeated
        // failures and duplicate queue deliveries across the whole ECS fleet.
        if let Some((pool, prefix)) = self.relayer_repository.connection_info() {
            let mut conn = pool
                .get()
                .await
                .map_err(|e| RelayerError::ProviderError(e.to_string()))?;
            let acquired: Option<String> = redis::cmd("SET")
                .arg(format!("{prefix}:nonce_receipt_recovery_gate:{}", live.id))
                .arg(&claim)
                .arg("NX")
                .arg("EX")
                .arg(55)
                .query_async(&mut *conn)
                .await
                .map_err(|e| RelayerError::ProviderError(e.to_string()))?;
            if acquired.is_none() {
                return Ok(());
            }
        } else {
            let gate = LOCAL_GATE.get_or_init(DashMap::new);
            match gate.entry(live.id.clone()) {
                dashmap::mapref::entry::Entry::Occupied(mut entry) => {
                    if entry.get().elapsed() < Duration::from_secs(55) {
                        return Ok(());
                    }
                    entry.insert(Instant::now());
                }
                dashmap::mapref::entry::Entry::Vacant(entry) => {
                    entry.insert(Instant::now());
                }
            }
        }
        // Persist the next heartbeat BEFORE querying RPCs. Errors/timeouts cannot
        // permanently orphan the hold; duplicates are suppressed by the gate.
        if let Err(error) = self
            .job_producer
            .produce_relayer_health_check_job(
                RelayerHealthCheck::nonce_receipt_recovery(live.id.clone()),
                Some(calculate_scheduled_timestamp(INTERVAL_SECS)),
            )
            .await
        {
            if let Some((pool, prefix)) = self.relayer_repository.connection_info() {
                if let Ok(mut conn) = pool.get().await {
                    let _: Result<bool, _> = redis::Script::new("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) == 1 end return false")
                        .key(format!("{prefix}:nonce_receipt_recovery_gate:{}", live.id)).arg(claim)
                        .invoke_async(&mut *conn).await;
                }
            } else {
                LOCAL_GATE.get_or_init(DashMap::new).remove(&live.id);
            }
            return Err(error.into());
        }
        match tokio::time::timeout(
            Duration::from_secs(40),
            self.reconcile_receipts(&live, &token),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                warn!(relayer_id = %live.id, "receipt recovery timed out; hold retained");
                Ok(())
            }
        }
    }

    async fn reconcile_receipts(
        &self,
        live: &RelayerRepoModel,
        token: &str,
    ) -> Result<(), RelayerError> {
        let error = |e: crate::services::provider::ProviderError| {
            RelayerError::ProviderError(e.to_string())
        };
        let chain = self
            .provider
            .raw_request_dyn("eth_chainId", json!([]))
            .await
            .map_err(error)?;
        if hex_u64(&chain) != Some(self.network.chain_id) {
            return Err(RelayerError::ProviderError(
                "Recovery provider chain mismatch".into(),
            ));
        }
        let tip = self.provider.get_block_number().await.map_err(error)?;
        let owners = self
            .transaction_repository
            .find_nonce_recovery_transactions(&live.id, BATCH_SIZE)
            .await?;
        let latest_value = self
            .provider
            .raw_request_dyn("eth_getTransactionCount", json!([live.address, "latest"]))
            .await
            .map_err(error)?;
        let latest = hex_u64(&latest_value)
            .ok_or_else(|| RelayerError::ProviderError("Invalid latest nonce".into()))?;
        for tx in &owners {
            let data = tx
                .network_data
                .get_evm_transaction_data()
                .map_err(|e| RelayerError::ProviderError(e.to_string()))?;
            if data.from.to_lowercase() != live.address.to_lowercase()
                || data.chain_id != self.network.chain_id
            {
                return Err(RelayerError::ProviderError(
                    "Recovery owner signer/chain mismatch".into(),
                ));
            }
            let Some(nonce) = data.nonce.filter(|nonce| *nonce < latest) else {
                continue;
            };
            let Some(hash) = data.hash.as_deref() else {
                continue;
            };
            // Historical hashes can reflect a different (e.g. canceled) intent.
            // Current known signed hash is sufficient for safe healing; other
            // consumed nonce outcomes remain held for operator reconciliation.
            let receipt = self
                .provider
                .raw_request_dyn("eth_getTransactionReceipt", json!([hash]))
                .await
                .map_err(error)?;
            if receipt.is_null() {
                continue;
            }
            let mined = self
                .provider
                .raw_request_dyn("eth_getTransactionByHash", json!([hash]))
                .await
                .map_err(error)?;
            let block = self
                .provider
                .raw_request_dyn(
                    "eth_getBlockByNumber",
                    json!([receipt["blockNumber"], false]),
                )
                .await
                .map_err(error)?;
            if let Some((succeeded, mined_at)) = prove_receipt(
                tx,
                hash,
                &receipt,
                &mined,
                &block,
                tip,
                self.network.required_confirmations,
            ) {
                let reconciled = self
                    .transaction_repository
                    .reconcile_mined_auto_failure(tx.clone(), succeeded, mined_at)
                    .await?;
                info!(event = "nonce_receipt_reconciled", relayer_id = %live.id, transaction_id = %tx.id,
                    hash, nonce, status = %reconciled.status, reason = ?reconciled.status_reason,
                    "confirmed receipt resolved automatic nonce hold");
            }
        }
        if !self
            .transaction_repository
            .find_nonce_recovery_transactions(&live.id, 1)
            .await?
            .is_empty()
        {
            return Ok(());
        }
        let pending_value = self
            .provider
            .raw_request_dyn("eth_getTransactionCount", json!([live.address, "pending"]))
            .await
            .map_err(error)?;
        if hex_u64(&pending_value) != Some(latest)
            || self.transaction_counter_service.get().await.ok().flatten() != Some(latest)
        {
            warn!(relayer_id = %live.id, "receipt hold resolved but nonce reservations differ; operator reconciliation required");
            return Ok(());
        }
        // Redis CAS rechecks token, empty owner index and unchanged counter in
        // one operation; an in-flight failure or manual PATCH defeats resume.
        if self
            .relayer_repository
            .resume_nonce_recovery(live.id.clone(), token.to_string(), latest)
            .await?
        {
            info!(event = "nonce_receipt_recovery_resumed", relayer_id = %live.id, nonce = latest, "automatic hold resolved; signer resumed");
        }
        Ok(())
    }
}
