use async_trait::async_trait;
use openzeppelin_relayer::{
    domain::transaction::evm::PriceCalculator,
    models::{
        evm::Speed, EvmNetwork, EvmTransactionData, RelayerRepoModel, RpcConfig, TransactionError,
    },
    services::gas::evm_gas_price::{EvmGasPriceServiceTrait, GasPrices, SpeedPrices},
};

struct Market {
    network: EvmNetwork,
}
#[async_trait]
impl EvmGasPriceServiceTrait for Market {
    type Provider = openzeppelin_relayer::services::provider::EvmProvider;
    async fn estimate_gas(&self, _: &EvmTransactionData) -> Result<u64, TransactionError> {
        panic!("Pricing must not simulate")
    }
    async fn get_legacy_prices_from_json_rpc(&self) -> Result<SpeedPrices, TransactionError> {
        Ok(SpeedPrices {
            safe_low: 25_000_000,
            average: 25_000_000,
            fast: 25_000_000,
            fastest: 25_000_000,
        })
    }
    async fn get_prices_from_json_rpc(&self) -> Result<GasPrices, TransactionError> {
        Ok(GasPrices {
            legacy_prices: self.get_legacy_prices_from_json_rpc().await?,
            max_priority_fee_per_gas: SpeedPrices {
                safe_low: 0,
                average: 0,
                fast: 0,
                fastest: 0,
            },
            base_fee_per_gas: 25_000_000,
        })
    }
    async fn get_current_base_fee(&self) -> Result<u128, TransactionError> {
        Ok(25_000_000)
    }
    fn network(&self) -> &EvmNetwork {
        &self.network
    }
}
fn market() -> Market {
    Market {
        network: EvmNetwork {
            network: "arbitrum".into(),
            rpc_urls: vec![RpcConfig::new("https://example.invalid".into())],
            explorer_urls: None,
            average_blocktime_ms: 250,
            is_testnet: false,
            tags: vec![],
            chain_id: 42161,
            required_confirmations: 1,
            status_check_initial_delay_seconds: 8,
            status_check_retry_delay_seconds: 8,
            features: vec![],
            symbol: "ETH".into(),
            gas_price_cache: None,
        },
    }
}
#[tokio::test]
async fn arbitrum_repricing_refreshes_persisted_legacy_fee() {
    let calculator = PriceCalculator::new(market(), None);
    let tx = EvmTransactionData {
        gas_price: Some(20_006_000),
        gas_limit: Some(77_438),
        speed: Some(Speed::Average),
        fee_ceiling_wei: None,
        nonce: Some(117480),
        value: openzeppelin_relayer::models::U256::ZERO,
        data: Some("0xb6d70dc6".into()),
        from: "0x0000000000000000000000000000000000000001".into(),
        to: Some("0x0000000000000000000000000000000000000002".into()),
        chain_id: 42161,
        hash: None,
        signature: None,
        max_fee_per_gas: None,
        max_priority_fee_per_gas: None,
        raw: None,
    };
    let result = calculator
        .calculate_bumped_gas_price(&tx, &RelayerRepoModel::default(), false)
        .await
        .unwrap();
    assert!(
        result.gas_price.unwrap() >= 25_000_000,
        "Persisted fee must be replaced by a fresh market fee"
    );
    assert!(result.gas_price.unwrap() > tx.gas_price.unwrap());
}

fn transaction(
    status: openzeppelin_relayer::models::TransactionStatus,
) -> openzeppelin_relayer::models::TransactionRepoModel {
    serde_json::from_value(serde_json::json!({
        "id":"00000000-0000-0000-0000-000000000001","relayer_id":"arbitrum-node-1","status":status,
        "status_reason":null,"created_at":"2026-10-14T10:00:00Z","sent_at":null,"confirmed_at":null,
        "valid_until":null,"delete_at":null,"priced_at":null,"hashes":[],"network_type":"evm","noop_count":0,"is_canceled":false,
        "network_data":{"network_data":"Evm","data":{"gas_price":"20006000","gas_limit":77438,"nonce":117480,"value":"0x0","data":"0xb6d70dc6","from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","chain_id":42161,"hash":"0xoriginal","signature":null,"speed":"average","max_fee_per_gas":null,"max_priority_fee_per_gas":null,"raw":[1,2,3]}}
    })).unwrap()
}

#[tokio::test]
async fn terminal_failure_preserves_intent_against_stale_noop_worker() {
    use openzeppelin_relayer::{
        models::{NetworkTransactionData, TransactionStatus, TransactionUpdateRequest},
        repositories::{InMemoryTransactionRepository, Repository, TransactionRepository},
    };
    let repo = InMemoryTransactionRepository::new();
    let tx = transaction(TransactionStatus::Sent);
    let id = tx.id.clone();
    repo.create(tx.clone()).await.unwrap();
    repo.partial_update(id.clone(),TransactionUpdateRequest{status:Some(TransactionStatus::Failed),status_reason:Some("Automatic submission failed: retry budget exhausted; nonce requires reconciliation".into()),..Default::default()}).await.unwrap();
    let mut noop = tx.network_data.get_evm_transaction_data().unwrap();
    noop.to = Some(noop.from.clone());
    noop.data = Some("0x".into());
    let updated = repo
        .partial_update(
            id,
            TransactionUpdateRequest {
                network_data: Some(NetworkTransactionData::Evm(noop)),
                noop_count: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(updated.network_data).unwrap(),
        serde_json::to_value(tx.network_data).unwrap(),
        "A terminal reconciliation failure must not be rewritten as a NOOP"
    );
}

#[tokio::test]
async fn fees_refresh_for_all_guarded_chains_and_both_fee_modes() {
    for (name, chain_id) in [
        ("arbitrum", 42161),
        ("matic", 137),
        ("avalanche", 43114),
        ("linea", 59144),
        ("monad", 143),
    ] {
        for eip1559 in [false, true] {
            let mut service = market();
            service.network.network = name.into();
            service.network.chain_id = chain_id;
            let calculator = PriceCalculator::new(service, None);
            let mut tx = transaction(openzeppelin_relayer::models::TransactionStatus::Sent)
                .network_data
                .get_evm_transaction_data()
                .unwrap();
            tx.chain_id = chain_id;
            if eip1559 {
                tx.gas_price = None;
                tx.max_fee_per_gas = Some(20_006_000);
                tx.max_priority_fee_per_gas = Some(1_000_000);
            }
            let p = calculator
                .calculate_bumped_gas_price(&tx, &RelayerRepoModel::default(), false)
                .await
                .unwrap();
            assert_eq!(p.is_min_bumped, Some(true), "{name}, eip1559={eip1559}");
            assert!(p.gas_price.or(p.max_fee_per_gas).unwrap() >= 25_000_000);
            let updated = tx.clone().with_price_params(p);
            assert_eq!(updated.nonce, tx.nonce);
            assert_eq!(updated.to, tx.to);
            assert_eq!(updated.data, tx.data);
        }
    }
}

#[tokio::test]
async fn action_and_relayer_caps_cannot_be_bypassed_by_repricing() {
    use openzeppelin_relayer::models::{RelayerEvmPolicy, RelayerNetworkPolicy, TransactionStatus};
    for eip1559 in [false, true] {
        for force_bump in [false, true] {
            let mut tx = transaction(TransactionStatus::Sent)
                .network_data
                .get_evm_transaction_data()
                .unwrap();
            if eip1559 {
                tx.gas_price = None;
                tx.max_fee_per_gas = Some(20_006_000);
                tx.max_priority_fee_per_gas = Some(1_000_000);
            }
            tx.fee_ceiling_wei = Some(22_100_000);
            let calculator = PriceCalculator::new(market(), None);
            let p = calculator
                .calculate_bumped_gas_price(&tx, &RelayerRepoModel::default(), force_bump)
                .await
                .unwrap();
            assert_eq!(p.is_min_bumped, Some(false));
            assert!(p.gas_price.or(p.max_fee_per_gas).unwrap() <= 22_100_000);
            tx.with_price_params(p).validate_fee_ceiling().unwrap();
        }
    }
    let tx = transaction(TransactionStatus::Sent)
        .network_data
        .get_evm_transaction_data()
        .unwrap();
    let mut relayer = RelayerRepoModel::default();
    relayer.policies = RelayerNetworkPolicy::Evm(RelayerEvmPolicy {
        gas_price_cap: Some(21_000_000),
        ..Default::default()
    });
    let p = PriceCalculator::new(market(), None)
        .calculate_bumped_gas_price(&tx, &relayer, false)
        .await
        .unwrap();
    assert_eq!(p.gas_price, Some(21_000_000));
    assert_eq!(p.is_min_bumped, Some(false));
}

#[tokio::test]
async fn terminal_failure_is_persisted_with_nonce_raw_bytes_and_hashes_intact() {
    use openzeppelin_relayer::{
        jobs::persist_automatic_submission_failure,
        models::TransactionStatus,
        repositories::{InMemoryTransactionRepository, Repository, TransactionRepository},
    };
    for status in [TransactionStatus::Sent, TransactionStatus::Submitted] {
        let repo = InMemoryTransactionRepository::new();
        let tx = transaction(status);
        let original = serde_json::to_value(&tx.network_data).unwrap();
        repo.create(tx.clone()).await.unwrap();
        let failed = persist_automatic_submission_failure(&repo, &tx.id, "intrinsic gas too low")
            .await
            .unwrap();
        assert_eq!(failed.status, TransactionStatus::Failed);
        assert!(failed.requires_nonce_reconciliation());
        assert_eq!(
            serde_json::to_value(&failed.network_data).unwrap(),
            original
        );
        assert_eq!(failed.hashes, tx.hashes);
        let owner = repo
            .find_by_nonce(&tx.relayer_id, 117480)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.id, tx.id);
        assert!(owner.requires_nonce_reconciliation());
        let repeated = persist_automatic_submission_failure(&repo, &tx.id, "late retry")
            .await
            .unwrap();
        assert_eq!(repeated.status_reason, failed.status_reason);
    }
}

#[tokio::test]
async fn concurrent_mined_or_confirmed_result_wins_over_automatic_failure() {
    use openzeppelin_relayer::{
        jobs::persist_automatic_submission_failure,
        models::TransactionStatus,
        repositories::{InMemoryTransactionRepository, Repository},
    };
    for status in [TransactionStatus::Mined, TransactionStatus::Confirmed] {
        let repo = InMemoryTransactionRepository::new();
        let tx = transaction(status.clone());
        repo.create(tx.clone()).await.unwrap();
        let after = persist_automatic_submission_failure(&repo, &tx.id, "late failed delivery")
            .await
            .unwrap();
        assert_eq!(after.status, status);
        assert!(!after.requires_nonce_reconciliation());
    }
}

#[test]
fn immediate_repricing_requires_a_definite_fee_rejection() {
    use openzeppelin_relayer::jobs::is_fee_repricing_error;
    for error in [
        "max fee per gas less than block base fee: maxFeePerGas 20006000 baseFee 20052000",
        "replacement transaction underpriced",
        "gas price too low",
    ] {
        assert!(is_fee_repricing_error(error));
    }
    for error in [
        "request timed out",
        "HTTP 503",
        "nonce too high",
        "nonce too low",
        "intrinsic gas too low",
        "insufficient funds",
        "already known",
    ] {
        assert!(!is_fee_repricing_error(error));
    }
}

#[test]
fn cleanup_retains_unresolved_nonce_owner_but_expires_normal_failures() {
    use openzeppelin_relayer::{
        jobs::should_delete_transaction,
        models::{TransactionRepoModel, TransactionStatus},
    };
    let mut tx = transaction(TransactionStatus::Sent);
    tx.apply_partial_update(TransactionRepoModel::automatic_submission_failure(
        "retry budget exhausted",
    ));
    tx.delete_at = Some("2000-01-01T00:00:00Z".into());
    assert!(!should_delete_transaction(&tx, chrono::Utc::now()));
    tx.status_reason = Some("On-chain transaction reverted".into());
    assert!(should_delete_transaction(&tx, chrono::Utc::now()));
}
