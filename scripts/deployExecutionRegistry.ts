import 'dotenv/config';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { compileExecutionRegistryContract } from '../server/services/executionRegistryArtifact';

async function main() {
  if (!process.env.OPBNB_RPC_URL || !process.env.EXECUTOR_PRIVATE_KEY) {
    throw new Error('OPBNB_RPC_URL and EXECUTOR_PRIVATE_KEY are required');
  }

  const compiled = compileExecutionRegistryContract();
  const compileErrors = compiled.errors.filter((error) => error.severity === 'error');
  if (compileErrors.length > 0) {
    throw new Error(compileErrors.map((error) => error.formattedMessage).join('\n'));
  }

  const provider = new JsonRpcProvider(process.env.OPBNB_RPC_URL);
  const wallet = new Wallet(process.env.EXECUTOR_PRIVATE_KEY, provider);
  const factory = new ContractFactory(compiled.abi, `0x${compiled.bytecode}`, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  console.log(
    JSON.stringify(
      {
        address: await contract.getAddress(),
        deployer: await wallet.getAddress(),
        deploymentTxHash: contract.deploymentTransaction()?.hash ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
