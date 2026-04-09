// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DelegatedExecutionVault {
    struct DelegationPolicy {
        address owner;
        address executor;
        address inputToken;
        address outputToken;
        uint96 maxOrderSize;
        uint16 maxSlippageBps;
        uint96 dailyLossLimit;
        uint64 validUntil;
        bool active;
    }

    mapping(bytes32 => DelegationPolicy) public policies;

    event PolicyUpserted(bytes32 indexed policyId, address indexed owner, address indexed executor);
    event PolicyRevoked(bytes32 indexed policyId);
    event DelegatedSwapExecuted(bytes32 indexed policyId, address router, uint256 amountIn, uint256 amountOutMin);

    error InvalidPolicy();
    error Unauthorized();
    error PolicyExpired();
    error PolicyInactive();

    function upsertPolicy(
        bytes32 policyId,
        address executor,
        address inputToken,
        address outputToken,
        uint96 maxOrderSize,
        uint16 maxSlippageBps,
        uint96 dailyLossLimit,
        uint64 validUntil
    ) external {
        if (executor == address(0) || inputToken == address(0) || outputToken == address(0) || validUntil <= block.timestamp) {
            revert InvalidPolicy();
        }

        policies[policyId] = DelegationPolicy({
            owner: msg.sender,
            executor: executor,
            inputToken: inputToken,
            outputToken: outputToken,
            maxOrderSize: maxOrderSize,
            maxSlippageBps: maxSlippageBps,
            dailyLossLimit: dailyLossLimit,
            validUntil: validUntil,
            active: true
        });

        emit PolicyUpserted(policyId, msg.sender, executor);
    }

    function revokePolicy(bytes32 policyId) external {
        DelegationPolicy storage policy = policies[policyId];
        if (policy.owner != msg.sender) {
            revert Unauthorized();
        }
        policy.active = false;
        emit PolicyRevoked(policyId);
    }

    function validatePolicy(bytes32 policyId, address executor, uint256 amountIn, uint256 slippageBps) public view returns (DelegationPolicy memory) {
        DelegationPolicy memory policy = policies[policyId];
        if (policy.owner == address(0)) {
            revert InvalidPolicy();
        }
        if (!policy.active) {
            revert PolicyInactive();
        }
        if (policy.executor != executor) {
            revert Unauthorized();
        }
        if (policy.validUntil < block.timestamp) {
            revert PolicyExpired();
        }
        if (amountIn > policy.maxOrderSize || slippageBps > policy.maxSlippageBps) {
            revert InvalidPolicy();
        }
        return policy;
    }

    function recordDelegatedExecution(bytes32 policyId, address router, uint256 amountIn, uint256 amountOutMin) external {
        validatePolicy(policyId, msg.sender, amountIn, 0);
        emit DelegatedSwapExecuted(policyId, router, amountIn, amountOutMin);
    }
}
