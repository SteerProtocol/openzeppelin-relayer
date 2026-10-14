use actix_web::{http::StatusCode, test, App};
use openzeppelin_relayer::api::routes::{configure_read_only_routes, relayer::is_read_only_rpc};
use serde_json::json;

#[test]
async fn rpc_policy_rejects_execution_and_batches() {
    assert!(is_read_only_rpc(
        &json!({"method": "eth_chainId", "params": []})
    ));
    assert!(is_read_only_rpc(
        &json!({"method": "eth_getTransactionCount", "params": []})
    ));
    for method in [
        "eth_sendRawTransaction",
        "eth_sendTransaction",
        "eth_sign",
        "personal_sign",
        "eth_call",
        "debug_traceTransaction",
        "unknown",
    ] {
        assert!(!is_read_only_rpc(&json!({"method": method, "params": []})));
    }
    assert!(!is_read_only_rpc(&json!([{"method": "eth_chainId"}])));
    assert!(!is_read_only_rpc(&json!({})));
}

#[actix_web::test]
async fn maintenance_never_registers_execution_or_mutation_handlers() {
    // No repositories, signer credentials, provider or queues: a mutation
    // handler would fail extraction rather than return the maintenance envelope.
    let app = test::init_service(App::new().configure(configure_read_only_routes)).await;
    for path in [
        "/plugins/steer-action/call",
        "/relayers/arbitrum-node-1/sign",
        "/relayers/arbitrum-node-1/sign-transaction",
        "/relayers/arbitrum-node-1/transactions",
        "/relayers/arbitrum-node-1/transactions/id/cancel",
        "/signers",
        "/networks",
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(path)
                .set_json(json!({}))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
        let body: serde_json::Value = test::read_body_json(response).await;
        assert_eq!(body["error"], "RELAYER_READ_ONLY", "{path}");
    }
    let response =
        test::call_service(&app, test::TestRequest::get().uri("/health").to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
}
