# Enforce Smart Contract Reentrancy Guards

## Problem
In Solidity smart contracts, invoking an external contract call transfers control execution to the recipient before contract state variables are updated. A malicious contract can re-enter the calling function recursively during the transfer to drain tokens or ether (SWC-107).

## Example
```solidity
// Vulnerable: state update occurs after external call
function withdraw() public {
    uint256 amount = balances[msg.sender];
    (bool sent, ) = msg.sender.call{value: amount}("");
    require(sent, "Ether transfer failed");
    balances[msg.sender] = 0;
}
```

## Fix
Apply the Checks-Effects-Interactions pattern (update state before external calls) and use OpenZeppelin's `nonReentrant` modifier.

```solidity
// Remediated: state updated before call + reentrancy guard
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

function withdraw() public nonReentrant {
    uint256 amount = balances[msg.sender];
    balances[msg.sender] = 0;
    (bool sent, ) = msg.sender.call{value: amount}("");
    require(sent, "Ether transfer failed");
}
```
