#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { registerDisasterRecoveryCommands } from "./cli/disaster-recovery.js";
import { registerBrainCommands } from "./cli/commands/brain.js";
import { registerHarnessAgentGitServiceCompatCommands, registerHarnessAgentGitServiceProvisioningCommands } from "./cli/commands/harness-ags.js";
import { registerHarnessCutoverReportCommand, registerHarnessPreflightCommands } from "./cli/commands/harness-preflight.js";
import { registerHarnessRunCommand } from "./cli/commands/harness-run.js";
import { registerHarnessRehearsalCommand, registerHarnessServeCommands, registerHarnessSmokeCommand } from "./cli/commands/harness-serve.js";
import { registerHooksInstallCommand, registerWorkspaceProjectGoalCommands } from "./cli/commands/workspace-project.js";

const program = new Command();
program.exitOverride();

program
  .name("loom")
  .description(
    "Operator CLI for a v3 cloud agentic dev platform.\n" +
      "Runs a first-party harness loop, keeps a native /goal adapter,\n" +
      "and feeds the skill-evolution brain.",
  )
  .version("0.1.0");

registerWorkspaceProjectGoalCommands(program);
registerBrainCommands(program);
registerHooksInstallCommand(program);

const harness = program.command("harness").description("first-party auditable harness loop");
registerHarnessRunCommand(harness);
registerHarnessAgentGitServiceProvisioningCommands(harness);
registerHarnessPreflightCommands(harness);
registerHarnessAgentGitServiceCompatCommands(harness);
registerHarnessCutoverReportCommand(harness);
registerHarnessRehearsalCommand(harness);
registerHarnessSmokeCommand(harness);
registerDisasterRecoveryCommands(harness);
registerHarnessServeCommands(harness);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
await Promise.all([
  new Promise<void>((resolve, reject) => process.stdout.write("", (error) => error ? reject(error) : resolve())),
  new Promise<void>((resolve, reject) => process.stderr.write("", (error) => error ? reject(error) : resolve())),
]);
