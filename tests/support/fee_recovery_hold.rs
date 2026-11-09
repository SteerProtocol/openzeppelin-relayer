#![allow(unused_variables)]
use super::{market, transaction, Market};
use alloy::{
    primitives::Bytes,
    rpc::types::{BlockNumberOrTag, FeeHistory, TransactionRequest},
};
use async_trait::async_trait;
use openzeppelin_relayer::{
    domain::{
        transaction::{
            evm::{EvmRelayerTransaction, PriceCalculator},
            Transaction,
        },
        SignTransactionResponse,
    },
    jobs::*,
    models::*,
    repositories::*,
    services::{
        provider::{EvmProviderTrait, ProviderError},
        signer::Signer,
    },
};
use std::sync::Arc;
struct Never;
#[async_trait]
impl EvmProviderTrait for Never {
    fn get_configs(&self) -> Vec<RpcConfig> {
        panic!("unexpected provider call")
    }
    async fn get_balance(&self, address: &str) -> Result<U256, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_block_number(&self) -> Result<u64, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn estimate_gas(&self, tx: &EvmTransactionData) -> Result<u64, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_gas_price(&self) -> Result<u128, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn send_transaction(&self, tx: TransactionRequest) -> Result<String, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn send_raw_transaction(&self, tx: &[u8]) -> Result<String, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn health_check(&self) -> Result<bool, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_transaction_count(&self, address: &str) -> Result<u64, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_fee_history(
        &self,
        block_count: u64,
        newest_block: BlockNumberOrTag,
        reward_percentiles: Vec<f64>,
    ) -> Result<FeeHistory, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_block_by_number(&self) -> Result<BlockResponse, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_transaction_receipt(
        &self,
        tx_hash: &str,
    ) -> Result<Option<TransactionReceipt>, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn call_contract(&self, tx: &TransactionRequest) -> Result<Bytes, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn raw_request_dyn(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn raw_request_dyn_best_effort(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_call_revert_data(
        &self,
        tx: &TransactionRequest,
        block_number: u64,
    ) -> Result<Option<Bytes>, ProviderError> {
        panic!("unexpected provider call")
    }
}
#[async_trait]
impl Signer for Never {
    async fn address(&self) -> Result<Address, SignerError> {
        panic!("unexpected signer call")
    }
    async fn sign_transaction(
        &self,
        tx: NetworkTransactionData,
    ) -> Result<SignTransactionResponse, SignerError> {
        panic!("unexpected signing")
    }
}
#[async_trait]
impl JobProducerTrait for Never {
    async fn produce_transaction_request_job(
        &self,
        j: TransactionRequestJob,
        at: Option<i64>,
    ) -> Result<(), JobProducerError> {
        panic!("unexpected enqueue")
    }
    async fn produce_submit_transaction_job(
        &self,
        j: TransactionSend,
        at: Option<i64>,
    ) -> Result<(), JobProducerError> {
        panic!("unexpected broadcast enqueue")
    }
    async fn produce_check_transaction_status_job(
        &self,
        j: TransactionStatusCheck,
        at: Option<i64>,
    ) -> Result<(), JobProducerError> {
        panic!("unexpected status enqueue")
    }
    async fn produce_send_notification_job(
        &self,
        j: NotificationSend,
        at: Option<i64>,
    ) -> Result<(), JobProducerError> {
        panic!("unexpected notification")
    }
    async fn produce_token_swap_request_job(
        &self,
        j: TokenSwapRequest,
        at: Option<i64>,
    ) -> Result<(), JobProducerError> {
        panic!("unexpected swap")
    }
    async fn produce_relayer_health_check_job(
        &self,
        j: RelayerHealthCheck,
        at: Option<i64>,
    ) -> Result<(), JobProducerError> {
        panic!("unexpected health enqueue")
    }
}
use openzeppelin_relayer::jobs::TransactionRequest as TransactionRequestJob;
type Handler = EvmRelayerTransaction<
    Never,
    InMemoryRelayerRepository,
    InMemoryNetworkRepository,
    InMemoryTransactionRepository,
    Never,
    Never,
    InMemoryTransactionCounter,
    PriceCalculator<Market>,
>;
fn relayer(paused: bool) -> RelayerRepoModel {
    let mut r = RelayerRepoModel::default();
    r.id = "arbitrum-node-1".into();
    r.name = "test".into();
    r.network_type = NetworkType::Evm;
    r.address = "0x0000000000000000000000000000000000000001".into();
    r.paused = paused;
    r.notification_id = None;
    r.policies = RelayerNetworkPolicy::Evm(RelayerEvmPolicy::default());
    r
}
fn handler(
    r: RelayerRepoModel,
    rr: Arc<InMemoryRelayerRepository>,
    tr: Arc<InMemoryTransactionRepository>,
    counter: Arc<InMemoryTransactionCounter>,
) -> Handler {
    EvmRelayerTransaction::new(
        r,
        Never,
        rr,
        Arc::new(InMemoryNetworkRepository::new()),
        tr,
        counter,
        Arc::new(Never),
        PriceCalculator::new(market(), None),
        Never,
    )
    .unwrap()
}
#[tokio::test]
async fn paused_status_checks_preserve_records_without_rpc() {
    for status in [
        TransactionStatus::Pending,
        TransactionStatus::Sent,
        TransactionStatus::Submitted,
        TransactionStatus::Mined,
    ] {
        let tx = transaction(status);
        let expected = serde_json::to_value(&tx).unwrap();
        let h = handler(
            relayer(true),
            Arc::new(InMemoryRelayerRepository::new()),
            Arc::new(InMemoryTransactionRepository::new()),
            Arc::new(InMemoryTransactionCounter::new()),
        );
        let out = h.handle_status_impl(tx, None).await.unwrap();
        assert_eq!(serde_json::to_value(out).unwrap(), expected);
    }
}
#[tokio::test]
async fn paused_workers_cannot_allocate_sign_or_broadcast() {
    let counter = Arc::new(InMemoryTransactionCounter::new());
    let r = relayer(true);
    counter.set(&r.id, &r.address, 118189).await.unwrap();
    let h = handler(
        r.clone(),
        Arc::new(InMemoryRelayerRepository::new()),
        Arc::new(InMemoryTransactionRepository::new()),
        counter.clone(),
    );
    assert!(h
        .prepare_transaction(transaction(TransactionStatus::Pending))
        .await
        .is_err());
    assert!(h
        .submit_transaction(transaction(TransactionStatus::Sent))
        .await
        .is_err());
    assert!(h
        .resubmit_transaction(transaction(TransactionStatus::Sent))
        .await
        .is_err());
    assert_eq!(counter.get(&r.id, &r.address).await.unwrap(), Some(118189));
}
#[tokio::test]
async fn capped_retry_persists_hold_and_preserves_signed_nonce() {
    let rr = Arc::new(InMemoryRelayerRepository::new());
    let tr = Arc::new(InMemoryTransactionRepository::new());
    let counter = Arc::new(InMemoryTransactionCounter::new());
    let r = relayer(false);
    rr.create(r.clone()).await.unwrap();
    counter.set(&r.id, &r.address, 117481).await.unwrap();
    let mut tx = transaction(TransactionStatus::Sent);
    if let NetworkTransactionData::Evm(ref mut d) = tx.network_data {
        d.fee_ceiling_wei = Some(20_799_759)
    }
    tr.create(tx.clone()).await.unwrap();
    let original = serde_json::to_value(&tx.network_data).unwrap();
    let h = handler(r.clone(), rr.clone(), tr.clone(), counter.clone());
    let out = h.resubmit_transaction(tx.clone()).await.unwrap();
    assert!(out.requires_nonce_reconciliation());
    assert!(rr.get_by_id(r.id.clone()).await.unwrap().paused);
    let stored = tr.get_by_id(tx.id).await.unwrap();
    assert!(stored.requires_nonce_reconciliation());
    assert_eq!(serde_json::to_value(stored.network_data).unwrap(), original);
    assert_eq!(counter.get(&r.id, &r.address).await.unwrap(), Some(117481));
}
#[tokio::test]
async fn missing_hold_record_cannot_make_allocated_nonce_terminal() {
    let rr = Arc::new(InMemoryRelayerRepository::new());
    let tr = Arc::new(InMemoryTransactionRepository::new());
    let counter = Arc::new(InMemoryTransactionCounter::new());
    let r = relayer(false);
    let mut tx = transaction(TransactionStatus::Sent);
    if let NetworkTransactionData::Evm(ref mut d) = tx.network_data {
        d.fee_ceiling_wei = Some(20_799_759)
    }
    tr.create(tx.clone()).await.unwrap();
    let original = serde_json::to_value(&tx).unwrap();
    let h = handler(r, rr, tr.clone(), counter);
    assert!(h.resubmit_transaction(tx.clone()).await.is_err());
    assert_eq!(
        serde_json::to_value(tr.get_by_id(tx.id).await.unwrap()).unwrap(),
        original
    );
}
#[tokio::test]
async fn preexisting_failed_owner_is_adopted_without_rpc_or_replay() {
    let rr = Arc::new(InMemoryRelayerRepository::new());
    let tr = Arc::new(InMemoryTransactionRepository::new());
    let r = relayer(false);
    rr.create(r.clone()).await.unwrap();
    let mut tx = transaction(TransactionStatus::Sent);
    tx.apply_partial_update(TransactionRepoModel::automatic_submission_failure(
        "expired",
    ));
    tr.create(tx.clone()).await.unwrap();
    let expected = serde_json::to_value(&tx).unwrap();
    let h = handler(
        r.clone(),
        rr.clone(),
        tr,
        Arc::new(InMemoryTransactionCounter::new()),
    );
    let out = h.handle_status_impl(tx, None).await.unwrap();
    assert!(rr.get_by_id(r.id).await.unwrap().paused);
    assert_eq!(serde_json::to_value(out).unwrap(), expected);
}
