import { runProviderTests } from "./provider.test.js";
import { runSapTests } from "./sap.test.js";

export async function run(): Promise<void> {
  await runProviderTests();
  await runSapTests();
}
