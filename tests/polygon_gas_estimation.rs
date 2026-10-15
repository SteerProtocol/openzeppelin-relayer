use openzeppelin_relayer::domain::transaction::evm::buffered_gas_estimate;

#[test]
fn polygon_vote_budget_covers_observed_state_change() {
    // 74,592 is a raw estimate producing the observed 82,051 limit at 10%.
    let limit = buffered_gas_estimate(137, 74_592).unwrap();
    // Another keeper's successful vote consumed 91,657 gas.
    assert!(
        limit > 91_657,
        "Polygon vote budget {limit} cannot cover the observed gas usage"
    );
    assert_eq!(limit, 111_888);
}

#[test]
fn polygon_budget_rounds_up() {
    assert_eq!(buffered_gas_estimate(137, 74_593).unwrap(), 111_890);
}

#[test]
fn other_chains_retain_their_existing_budget() {
    for chain_id in [1, 143, 42161, 43114, 59144] {
        assert_eq!(buffered_gas_estimate(chain_id, 74_592).unwrap(), 82_051);
    }
}

#[test]
fn oversized_rpc_estimates_cannot_wrap_to_a_small_limit() {
    for chain_id in [137, 42161] {
        assert!(buffered_gas_estimate(chain_id, u64::MAX).is_err());
    }
}

#[test]
fn large_representable_estimates_do_not_overflow_intermediate_multiplication() {
    assert_eq!(
        buffered_gas_estimate(137, 10_000_000_000_000_000_000).unwrap(),
        15_000_000_000_000_000_000
    );
}
