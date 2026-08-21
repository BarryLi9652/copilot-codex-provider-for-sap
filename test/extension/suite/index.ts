import { runCommandTests } from "./commands.test.js";
import { runProviderTests } from "./provider.test.js";
import { runSapTests } from "./sap.test.js";

export async function run(): Promise<void> {
  await runCommandTests();
  await runProviderTests();
  await runSapTests();
}
