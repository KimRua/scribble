// SPDX-License-Identifier: MIT
pragma solidity ^0.5.0;
pragma experimental ABIEncoderV2;

contract ExecutionRegistry {
    struct StrategyRegistration {
        address user;
        bool registered;
        uint256 registeredAt;
        uint256 triggerCount;
        uint256 lastTriggeredAt;
        bool lastResult;
    }

    mapping(bytes32 => StrategyRegistration) private registrations;

    event StrategyRegistered(bytes32 strategyId, address user);
    event ExecutionTriggered(bytes32 strategyId, address user);
    event ExecutionRecorded(bytes32 strategyId, bool success);

    function registerStrategy(bytes32 strategyId, address user) external {
        require(user != address(0), "invalid user");
        require(!registrations[strategyId].registered, "strategy already registered");

        registrations[strategyId] = StrategyRegistration({
            user: user,
            registered: true,
            registeredAt: block.timestamp,
            triggerCount: 0,
            lastTriggeredAt: 0,
            lastResult: false
        });

        emit StrategyRegistered(strategyId, user);
    }

    function triggerExecution(bytes32 strategyId, address user) external {
        StrategyRegistration storage registration = registrations[strategyId];
        require(registration.registered, "strategy not registered");
        require(registration.user == user && user != address(0), "invalid user");

        registration.triggerCount += 1;
        registration.lastTriggeredAt = block.timestamp;

        emit ExecutionTriggered(strategyId, user);
    }

    function recordResult(bytes32 strategyId, bool success) external {
        StrategyRegistration storage registration = registrations[strategyId];
        require(registration.registered, "strategy not registered");

        registration.lastResult = success;

        emit ExecutionRecorded(strategyId, success);
    }

    function getStrategy(bytes32 strategyId) external view returns (StrategyRegistration memory) {
        return registrations[strategyId];
    }
}
