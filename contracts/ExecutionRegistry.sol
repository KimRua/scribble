// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

    error StrategyAlreadyRegistered(bytes32 strategyId);
    error StrategyNotRegistered(bytes32 strategyId);
    error InvalidUser();

    function registerStrategy(bytes32 strategyId, address user) external {
        if (user == address(0)) {
            revert InvalidUser();
        }
        if (registrations[strategyId].registered) {
            revert StrategyAlreadyRegistered(strategyId);
        }

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
        if (!registration.registered) {
            revert StrategyNotRegistered(strategyId);
        }
        if (registration.user != user || user == address(0)) {
            revert InvalidUser();
        }

        registration.triggerCount += 1;
        registration.lastTriggeredAt = block.timestamp;

        emit ExecutionTriggered(strategyId, user);
    }

    function recordResult(bytes32 strategyId, bool success) external {
        StrategyRegistration storage registration = registrations[strategyId];
        if (!registration.registered) {
            revert StrategyNotRegistered(strategyId);
        }

        registration.lastResult = success;

        emit ExecutionRecorded(strategyId, success);
    }

    function getStrategy(bytes32 strategyId) external view returns (StrategyRegistration memory) {
        return registrations[strategyId];
    }
}
