use openzeppelin_relayer::{models::*, repositories::*};

#[tokio::test]
async fn manual_pause_revokes_automatic_resume_permission() {
    let repo = InMemoryRelayerRepository::new();
    let mut relayer = RelayerRepoModel::default();
    relayer.id = "matic-node-1".into();
    relayer.name = "Polygon".into();
    repo.create(relayer).await.unwrap();
    let held = repo
        .hold_for_nonce_recovery("matic-node-1".into(), "tx-1".into())
        .await
        .unwrap();
    assert!(held.paused);
    assert_eq!(held.nonce_recovery_hold.as_deref(), Some("tx-1"));
    repo.partial_update(
        "matic-node-1".into(),
        UpdateRelayerRequest {
            paused: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!repo
        .resume_nonce_recovery("matic-node-1".into(), "tx-1".into(), 1)
        .await
        .unwrap());
    assert!(repo.get_by_id("matic-node-1".into()).await.unwrap().paused);
}

#[tokio::test]
async fn automatic_recovery_never_adopts_an_existing_manual_pause() {
    let repo = InMemoryRelayerRepository::new();
    let mut relayer = RelayerRepoModel::default();
    relayer.id = "manual".into();
    relayer.paused = true;
    repo.create(relayer).await.unwrap();
    let held = repo
        .hold_for_nonce_recovery("manual".into(), "tx".into())
        .await
        .unwrap();
    assert!(held.paused);
    assert!(held.nonce_recovery_hold.is_none());
    assert!(!repo
        .resume_nonce_recovery("manual".into(), "tx".into(), 1)
        .await
        .unwrap());
}

#[tokio::test]
async fn receipt_reconciliation_preserves_intent_and_rejects_stale_proof() {
    let repo = InMemoryTransactionRepository::new();
    let tx = fixture_transaction("mined");
    repo.create(tx.clone()).await.unwrap();
    let actual = repo
        .reconcile_mined_auto_failure(tx.clone(), false, "2026-11-15T00:00:00Z".into())
        .await
        .unwrap();
    assert_eq!(actual.status, TransactionStatus::Failed);
    assert!(!actual.requires_nonce_reconciliation());
    assert_eq!(
        serde_json::to_value(&actual.network_data).unwrap(),
        serde_json::to_value(&tx.network_data).unwrap()
    );
    assert_eq!(actual.hashes, tx.hashes);
    assert!(actual.delete_at.is_some());
    assert!(repo
        .reconcile_mined_auto_failure(tx, true, "2026-11-15T00:00:00Z".into())
        .await
        .is_err());
    assert_eq!(
        repo.get_by_id("mined".into()).await.unwrap().status,
        TransactionStatus::Failed
    );
}

fn fixture_transaction(id: &str) -> TransactionRepoModel {
    serde_json::from_value(serde_json::json!({
        "id":id,"relayer_id":"matic-node-1","status":"failed",
        "status_reason":"Automatic submission failed: expired; nonce requires reconciliation",
        "created_at":"2026-11-15T00:00:00Z","sent_at":null,"confirmed_at":null,
        "valid_until":null,"delete_at":null,"priced_at":null,"hashes":["0xknown"],"network_type":"evm","noop_count":0,"is_canceled":false,
        "network_data":{"network_data":"Evm","data":{"gas_price":"20006000","gas_limit":77438,"nonce":42,"value":"0x0","data":"0xb6d70dc6","from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","chain_id":137,"hash":"0xknown","signature":null,"speed":"average","max_fee_per_gas":null,"max_priority_fee_per_gas":null,"raw":[1,2,3]}}
    })).unwrap()
}

#[path = "support/receipt_recovery.rs"]
mod receipt_recovery;
