#![allow(unused_variables)]
use super::fixture_transaction;
use alloy::{
    primitives::Bytes,
    rpc::types::{BlockNumberOrTag, FeeHistory, TransactionRequest},
};
use async_trait::async_trait;
use openzeppelin_relayer::jobs::TransactionRequest as TransactionRequestJob;
use openzeppelin_relayer::{
    domain::{EvmRelayer, SignDataRequest, SignDataResponse, SignTypedDataRequest},
    jobs::*,
    models::*,
    repositories::*,
    services::{
        provider::{EvmProviderTrait, ProviderError},
        signer::DataSignerTrait,
        TransactionCounterService,
    },
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct FixtureProvider {
    calls: Arc<AtomicUsize>,
    success: bool,
    missing: bool,
    fail: bool,
    tip: u64,
    receipt_from: String,
    block_hash: String,
}
impl Default for FixtureProvider {
    fn default() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            success: false,
            missing: false,
            fail: false,
            tip: 102,
            receipt_from: "0x0000000000000000000000000000000000000001".into(),
            block_hash: "0xcanonical".into(),
        }
    }
}
struct FixtureJobs {
    calls: Arc<AtomicUsize>,
    fail_first: bool,
}
struct NeverSigner;
#[async_trait]
impl DataSignerTrait for NeverSigner {
    async fn sign_data(&self, _: SignDataRequest) -> Result<SignDataResponse, SignerError> {
        panic!("Recovery must never sign")
    }
    async fn sign_typed_data(
        &self,
        _: SignTypedDataRequest,
    ) -> Result<SignDataResponse, SignerError> {
        panic!("Recovery must never sign")
    }
}
#[async_trait]
impl EvmProviderTrait for FixtureProvider {
    fn get_configs(&self) -> Vec<RpcConfig> {
        panic!("unexpected provider call")
    }
    async fn get_balance(&self, address: &str) -> Result<U256, ProviderError> {
        panic!("unexpected provider call")
    }
    async fn get_block_number(&self) -> Result<u64, ProviderError> {
        Ok(self.tip)
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
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(ProviderError::Other("test provider unavailable".into()));
        }
        let v = match method {
            "eth_chainId" => json!("0x89"),
            "eth_getTransactionCount" => json!("0x2b"),
            "eth_getTransactionReceipt" if self.missing => serde_json::Value::Null,
            "eth_getTransactionReceipt" => {
                json!({"transactionHash":"0xknown", "blockNumber":"0x64", "blockHash":self.block_hash,
                "from":self.receipt_from, "to":"0x0000000000000000000000000000000000000002", "status":if self.success {"0x1"} else {"0x0"}})
            }
            "eth_getTransactionByHash" => {
                json!({"hash":"0xknown", "blockHash":"0xcanonical", "from":"0x0000000000000000000000000000000000000001", "to":"0x0000000000000000000000000000000000000002", "nonce":"0x2a", "chainId":"0x89", "value":"0x0", "input":"0xb6d70dc6"})
            }
            "eth_getBlockByNumber" => {
                json!({"number":"0x64", "hash":"0xcanonical", "timestamp":"0x1"})
            }
            _ => panic!("unexpected RPC {method} {params}"),
        };
        Ok(v)
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
impl JobProducerTrait for FixtureJobs {
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
        assert_eq!(
            j.metadata
                .as_ref()
                .and_then(|m| m.get("health_check_action"))
                .map(String::as_str),
            Some("nonce_receipt_recovery")
        );
        assert!(at.is_some());
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_first && call == 0 {
            return Err(JobProducerError::QueueError(
                "test enqueue unavailable".into(),
            ));
        }
        Ok(())
    }
}

type Handler = EvmRelayer<
    FixtureProvider,
    InMemoryRelayerRepository,
    InMemoryNetworkRepository,
    InMemoryTransactionRepository,
    FixtureJobs,
    NeverSigner,
    TransactionCounterService<InMemoryTransactionCounter>,
>;
async fn setup(
    provider: FixtureProvider,
    fail_first: bool,
    automatic: bool,
) -> (
    Handler,
    Arc<InMemoryRelayerRepository>,
    Arc<InMemoryTransactionRepository>,
    String,
    Arc<AtomicUsize>,
) {
    let id = uuid::Uuid::new_v4().to_string();
    let rr = Arc::new(InMemoryRelayerRepository::new());
    let tr = Arc::new(InMemoryTransactionRepository::new());
    let mut tx = fixture_transaction("held");
    tx.relayer_id = id.clone();
    tr.create(tx).await.unwrap();
    let mut relayer = RelayerRepoModel::default();
    relayer.id = id.clone();
    relayer.name = "Polygon".into();
    relayer.address = "0x0000000000000000000000000000000000000001".into();
    relayer.paused = true;
    relayer.nonce_recovery_hold = automatic.then(|| "held".to_string());
    rr.create(relayer.clone()).await.unwrap();
    let store = Arc::new(InMemoryTransactionCounter::new());
    store.set(&id, &relayer.address, 43).await.unwrap();
    let counter = Arc::new(TransactionCounterService::new(
        id.clone(),
        relayer.address.clone(),
        store,
    ));
    let network = EvmNetwork {
        network: "matic".into(),
        rpc_urls: vec![],
        average_blocktime_ms: 2000,
        is_testnet: false,
        tags: vec![],
        chain_id: 137,
        required_confirmations: 2,
        status_check_initial_delay_seconds: 8,
        status_check_retry_delay_seconds: 8,
        features: vec![],
        symbol: "POL".into(),
        explorer_urls: None,
        gas_price_cache: None,
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let h = EvmRelayer::new(
        relayer,
        NeverSigner,
        provider,
        network,
        rr.clone(),
        Arc::new(InMemoryNetworkRepository::new()),
        tr.clone(),
        counter,
        Arc::new(FixtureJobs {
            calls: calls.clone(),
            fail_first,
        }),
    )
    .unwrap();
    (h, rr, tr, id, calls)
}
async fn run(h: &Handler) -> Result<bool, RelayerError> {
    h.handle_health_action(
        &RelayerHealthCheck::nonce_receipt_recovery("unused".into())
            .metadata
            .unwrap(),
    )
    .await
}
#[tokio::test]
async fn late_success_and_revert_receipts_resolve_automatic_holds_without_broadcasting() {
    for success in [false, true] {
        let (h, rr, tr, id, jobs) = setup(
            FixtureProvider {
                success,
                ..Default::default()
            },
            false,
            true,
        )
        .await;
        assert!(run(&h).await.unwrap());
        assert!(!rr.get_by_id(id).await.unwrap().paused);
        let tx = tr.get_by_id("held".into()).await.unwrap();
        assert_eq!(
            tx.status,
            if success {
                TransactionStatus::Confirmed
            } else {
                TransactionStatus::Failed
            }
        );
        assert!(!tx.requires_nonce_reconciliation());
        assert_eq!(jobs.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn manual_pauses_do_no_rpc_work_and_never_auto_resume() {
    let p = FixtureProvider::default();
    let calls = p.calls.clone();
    let (h, rr, _, id, jobs) = setup(p, false, false).await;
    run(&h).await.unwrap();
    assert!(rr.get_by_id(id).await.unwrap().paused);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(jobs.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn enqueue_failure_releases_gate_for_retry() {
    let (h, rr, _, id, jobs) = setup(FixtureProvider::default(), true, true).await;
    assert!(run(&h).await.is_err());
    assert!(rr.get_by_id(id.clone()).await.unwrap().paused);
    assert!(run(&h).await.unwrap());
    assert!(!rr.get_by_id(id).await.unwrap().paused);
    assert_eq!(jobs.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn missing_foreign_reorged_and_unconfirmed_receipts_keep_hold_and_bound_duplicate_checks() {
    for provider in [
        FixtureProvider {
            missing: true,
            ..Default::default()
        },
        FixtureProvider {
            receipt_from: "0xforeign".into(),
            ..Default::default()
        },
        FixtureProvider {
            block_hash: "0xorphan".into(),
            ..Default::default()
        },
        FixtureProvider {
            tip: 100,
            ..Default::default()
        },
    ] {
        let calls = provider.calls.clone();
        let (h, rr, _, id, jobs) = setup(provider, false, true).await;
        run(&h).await.unwrap();
        let first_calls = calls.load(Ordering::SeqCst);
        run(&h).await.unwrap();
        assert!(rr.get_by_id(id).await.unwrap().paused);
        assert_eq!(jobs.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), first_calls);
    }
}
#[tokio::test]
async fn provider_failure_keeps_durable_next_job_and_pause() {
    let (h, rr, _, id, jobs) = setup(
        FixtureProvider {
            fail: true,
            ..Default::default()
        },
        false,
        true,
    )
    .await;
    assert!(run(&h).await.is_err());
    assert!(rr.get_by_id(id).await.unwrap().paused);
    assert_eq!(jobs.load(Ordering::SeqCst), 1);
}
