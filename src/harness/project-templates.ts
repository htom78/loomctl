import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HARNESS_VISION_LOCK } from "./profile-contract.js";

export type ProjectTemplateName = "empty" | "vas-lite";

export interface ProjectTemplateMetadata {
  schemaVersion: 1;
  template: ProjectTemplateName;
  tenant: string;
  project: string;
  createdAt: string;
  defaultSkills?: string[];
  runPolicy?: ProjectTemplateRunPolicy;
  contract?: ProjectTemplateContract;
}

export interface ProjectTemplateRunPolicy {
  preset?: "vas-lite-review";
  presetInput?: {
    caseId: string;
  };
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
}

export interface ProjectTemplateContract {
  objective?: string;
  constraints?: string[];
  successCriteria?: string[];
}

export interface ProjectTemplateContractStatus {
  ok: boolean;
  missing: string[];
}

interface SeedProjectTemplateOptions {
  tenant: string;
  project: string;
  template: ProjectTemplateName;
  sourceDefaults?: ProjectTemplateSourceDefaults;
}

interface ProjectTemplateSourceDefaults {
  repo?: string;
  branch?: string;
  baseBranch?: string;
  issue?: string;
}

export async function seedProjectTemplate(projectRoot: string, options: SeedProjectTemplateOptions): Promise<void> {
  await writeProjectTemplateMetadata(projectRoot, projectTemplateMetadata(options));
  if (options.template === "empty") return;

  for (const [path, content] of vasLiteTemplateFiles(options.project, options.sourceDefaults ?? {})) {
    await writeTemplateFile(projectRoot, path, content);
  }
}

export async function ensureProjectTemplateMetadata(projectRoot: string, options: SeedProjectTemplateOptions): Promise<ProjectTemplateMetadata> {
  const existing = await readProjectTemplateMetadata(projectRoot, { tenant: options.tenant, project: options.project });
  if (existing) return existing;
  const metadata = projectTemplateMetadata(options);
  await writeProjectTemplateMetadata(projectRoot, metadata);
  return metadata;
}

export function projectTemplateDefaultSkills(template: ProjectTemplateName): string[] {
  if (template === "vas-lite") return ["vas-lite", "coding"];
  return [];
}

export function projectMetadataDefaultSkills(metadata: ProjectTemplateMetadata): string[] {
  if (metadata.defaultSkills !== undefined) return [...metadata.defaultSkills];
  return projectTemplateDefaultSkills(metadata.template);
}

export function projectTemplateContractStatus(metadata: ProjectTemplateMetadata | undefined): ProjectTemplateContractStatus | undefined {
  if (!metadata) return undefined;
  if (metadata.template !== "vas-lite" && !projectTemplateContractHasContent(metadata.contract)) return undefined;
  const missing = new Set<string>();
  const contract = metadata.contract;
  if (!projectTemplateContractHasContent(contract)) missing.add("contract");
  if (!contract?.objective?.trim()) missing.add("objective");
  if (!projectTemplateStringList(contract?.constraints).length) missing.add("constraints");
  if (!projectTemplateStringList(contract?.successCriteria).length) missing.add("successCriteria");
  if (metadata.template === "vas-lite") {
    const text = projectTemplateContractText(contract);
    for (const marker of VAS_LITE_CONTRACT_MARKERS) {
      if (!marker.terms.every((term) => text.includes(term))) missing.add(marker.id);
    }
  }
  return {
    ok: missing.size === 0,
    missing: [...missing],
  };
}

export async function updateProjectTemplateDefaultSkills(
  projectRoot: string,
  expected: ProjectTemplateMetadataExpectation,
  defaultSkills: string[],
): Promise<ProjectTemplateMetadata | undefined> {
  const metadata = await readProjectTemplateMetadata(projectRoot, expected);
  if (!metadata) return undefined;
  const updated = {
    ...metadata,
    defaultSkills: [...defaultSkills],
  };
  await writeProjectTemplateMetadata(projectRoot, updated);
  return updated;
}

export async function updateProjectTemplateRunPolicy(
  projectRoot: string,
  expected: ProjectTemplateMetadataExpectation,
  runPolicy: ProjectTemplateRunPolicy | undefined,
): Promise<ProjectTemplateMetadata | undefined> {
  const metadata = await readProjectTemplateMetadata(projectRoot, expected);
  if (!metadata) return undefined;
  const updated = {
    ...metadata,
    runPolicy,
  };
  await writeProjectTemplateMetadata(projectRoot, updated);
  return updated;
}

export async function updateProjectTemplateContract(
  projectRoot: string,
  expected: ProjectTemplateMetadataExpectation,
  contract: ProjectTemplateContract | undefined,
): Promise<ProjectTemplateMetadata | undefined> {
  const metadata = await readProjectTemplateMetadata(projectRoot, expected);
  if (!metadata) return undefined;
  const updated = {
    ...metadata,
    contract,
  };
  await writeProjectTemplateMetadata(projectRoot, updated);
  return updated;
}

function projectTemplateMetadata(options: SeedProjectTemplateOptions): ProjectTemplateMetadata {
  const defaultSkills = projectTemplateDefaultSkills(options.template);
  const contract = projectTemplateContract(options.template);
  return {
    schemaVersion: 1,
    template: options.template,
    tenant: options.tenant,
    project: options.project,
    createdAt: new Date().toISOString(),
    defaultSkills: defaultSkills.length ? defaultSkills : undefined,
    contract,
  };
}

const VAS_LITE_CONTRACT_MARKERS = [
  { id: "multi-user", terms: ["multi-user"] },
  { id: "online-sandbox", terms: ["online", "sandbox"] },
  { id: "harness-loop", terms: ["harness", "loop"] },
  { id: "human-gates", terms: ["review", "deployment", "gate"] },
  { id: "durable-evidence", terms: ["evidence", "durable"] },
  { id: "vas-learning", terms: ["vas", "learning"] },
];

function projectTemplateContractHasContent(contract: ProjectTemplateContract | undefined): boolean {
  return Boolean(
    contract?.objective?.trim() ||
    projectTemplateStringList(contract?.constraints).length ||
    projectTemplateStringList(contract?.successCriteria).length,
  );
}

function projectTemplateContractText(contract: ProjectTemplateContract | undefined): string {
  return [
    contract?.objective,
    ...projectTemplateStringList(contract?.constraints),
    ...projectTemplateStringList(contract?.successCriteria),
  ].filter(Boolean).join("\n").toLowerCase();
}

function projectTemplateStringList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

async function writeProjectTemplateMetadata(projectRoot: string, metadata: ProjectTemplateMetadata): Promise<void> {
  await writeTemplateFile(projectRoot, ".loom/project.json", JSON.stringify(metadata, null, 2) + "\n");
}

interface ProjectTemplateMetadataExpectation {
  tenant?: string;
  project?: string;
}

export async function readProjectTemplateMetadata(
  projectRoot: string,
  expected: ProjectTemplateMetadataExpectation = {},
): Promise<ProjectTemplateMetadata | undefined> {
  try {
    return projectTemplateMetadataFromUnknown(
      JSON.parse(await readFile(join(projectRoot, ".loom", "project.json"), "utf8")),
      expected,
    );
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function projectTemplateMetadataFromUnknown(
  value: unknown,
  expected: ProjectTemplateMetadataExpectation,
): ProjectTemplateMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parsed = value as Partial<ProjectTemplateMetadata>;
  if (parsed.schemaVersion !== 1) return undefined;
  if (parsed.template !== "empty" && parsed.template !== "vas-lite") return undefined;
  if (typeof parsed.tenant !== "string" || typeof parsed.project !== "string" || typeof parsed.createdAt !== "string") return undefined;
  if (expected.tenant !== undefined && parsed.tenant !== expected.tenant) return undefined;
  if (expected.project !== undefined && parsed.project !== expected.project) return undefined;
  let defaultSkills: string[] | undefined;
  if (parsed.defaultSkills !== undefined) {
    if (!Array.isArray(parsed.defaultSkills) || !parsed.defaultSkills.every((skill) => typeof skill === "string")) return undefined;
    defaultSkills = [...parsed.defaultSkills];
  }
  const runPolicy = projectTemplateRunPolicyFromUnknown(parsed.runPolicy);
  if (parsed.runPolicy !== undefined && !runPolicy) return undefined;
  const contract = projectTemplateContractFromUnknown(parsed.contract);
  if (parsed.contract !== undefined && !contract) return undefined;
  const metadata: ProjectTemplateMetadata = {
    schemaVersion: 1,
    template: parsed.template,
    tenant: parsed.tenant,
    project: parsed.project,
    createdAt: parsed.createdAt,
    defaultSkills,
    runPolicy,
    contract,
  };
  return metadata;
}

function projectTemplateRunPolicyFromUnknown(value: unknown): ProjectTemplateRunPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parsed = value as Partial<ProjectTemplateRunPolicy>;
  if (parsed.preset !== undefined && parsed.preset !== "vas-lite-review") return undefined;
  let presetInput: ProjectTemplateRunPolicy["presetInput"];
  if (parsed.presetInput !== undefined) {
    if (typeof parsed.presetInput !== "object" || parsed.presetInput === null || Array.isArray(parsed.presetInput)) return undefined;
    const input = parsed.presetInput as { caseId?: unknown };
    if (typeof input.caseId !== "string") return undefined;
    presetInput = { caseId: input.caseId };
  }
  if (parsed.reviewRequired !== undefined && typeof parsed.reviewRequired !== "boolean") return undefined;
  if (parsed.deploymentRequired !== undefined && typeof parsed.deploymentRequired !== "boolean") return undefined;
  return {
    preset: parsed.preset,
    presetInput,
    reviewRequired: parsed.reviewRequired,
    deploymentRequired: parsed.deploymentRequired,
  };
}

function projectTemplateContract(template: ProjectTemplateName): ProjectTemplateContract | undefined {
  if (template !== "vas-lite") return undefined;
  return {
    objective: HARNESS_VISION_LOCK.target,
    constraints: [
      "Keep harness/loop evidence durable in .loom project state.",
      "Keep human review and deployment gates explicit for side effects.",
      "Keep sandbox work file-backed so runs can resume, inspect, and audit it.",
      "Promote VAS corrections into durable learning updates only after review.",
    ],
    successCriteria: [
      "Tenant projects and runs are operable through the HTTP control plane and Dashboard.",
      "Runs record project contract, policy, events, verification, and gate decisions.",
      "VAS-lite cases can move from evidence to review to learning updates.",
    ],
  };
}

function projectTemplateContractFromUnknown(value: unknown): ProjectTemplateContract | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parsed = value as Partial<ProjectTemplateContract>;
  if (parsed.objective !== undefined && typeof parsed.objective !== "string") return undefined;
  const constraints = projectTemplateStringArrayFromUnknown(parsed.constraints);
  if (parsed.constraints !== undefined && !constraints) return undefined;
  const successCriteria = projectTemplateStringArrayFromUnknown(parsed.successCriteria);
  if (parsed.successCriteria !== undefined && !successCriteria) return undefined;
  return {
    objective: parsed.objective || undefined,
    constraints,
    successCriteria,
  };
}

function projectTemplateStringArrayFromUnknown(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return [...value];
}

async function writeTemplateFile(projectRoot: string, relativePath: string, content: string): Promise<void> {
  const target = join(projectRoot, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function vasLiteTemplateFiles(project: string, sourceDefaults: ProjectTemplateSourceDefaults): Array<[string, string]> {
  return [
    ["README.md", vasLiteReadme(project)],
    ["package.json", vasLitePackageJson(project)],
    ["src/loop.js", vasLiteLoopJs()],
    ["cases/bootstrap/case.json", vasLiteCaseJson(sourceDefaults)],
    ["cases/bootstrap/notes.md", vasLiteCaseNotes()],
    ["cases/bootstrap/frames/README.md", vasLiteFramesReadme()],
    ["cases/bootstrap/reconstruction/index.html", vasLiteReconstructionHtml()],
    ["vocabulary/teaching-beats.json", vasLiteTeachingBeatsJson()],
    ["vocabulary/learned-patterns.md", vasLiteLearnedPatterns()],
  ];
}

function vasLiteReadme(project: string): string {
  return [
    `# VAS Lite Project: ${project}`,
    "",
    "This is a small file-based video analysis system skeleton for an online Loom sandbox.",
    "",
    "The loop is intentionally explicit:",
    "",
    "```text",
    "ingest -> evidence -> prediction -> reconstruction -> review -> learning update",
    "```",
    "",
    "Use this project as the durable artifact layer for teaching-video analysis:",
    "",
    "- `cases/` stores source metadata, evidence notes, predictions, corrections, review drafts, and reconstruction links.",
    "- `vocabulary/` stores reusable teaching beats and learned patterns.",
    "- `src/loop.js` gives the sandbox a tiny runnable harness entrypoint.",
    "- `.loom/project.json` records the project template metadata for the control plane.",
    "",
    "Quick check:",
    "",
    "```bash",
    "npm test",
    "node src/loop.js status",
    "```",
    "",
  ].join("\n");
}

function vasLitePackageJson(project: string): string {
  return JSON.stringify({
    name: project,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      status: "node src/loop.js status",
      test: "node src/loop.js status",
    },
  }, null, 2) + "\n";
}

function vasLiteLoopJs(): string {
  return [
    "import { readdir, readFile } from \"node:fs/promises\";",
    "import { join } from \"node:path\";",
    "",
    "export const loop = \"ingest -> evidence -> prediction -> reconstruction -> review -> learning update\";",
    "",
    "export async function listCases(root = process.cwd()) {",
    "  let entries;",
    "  try {",
    "    entries = await readdir(join(root, \"cases\"), { withFileTypes: true });",
    "  } catch (error) {",
    "    if (error && error.code === \"ENOENT\") return [];",
    "    throw error;",
    "  }",
    "  const cases = [];",
    "  for (const entry of entries) {",
    "    if (!entry.isDirectory()) continue;",
    "    const path = join(root, \"cases\", entry.name, \"case.json\");",
    "    cases.push(JSON.parse(await readFile(path, \"utf8\")));",
    "  }",
    "  return cases.sort((a, b) => String(a.id).localeCompare(String(b.id)));",
    "}",
    "",
    "export async function unresolvedUncertainties(root = process.cwd()) {",
    "  const cases = await listCases(root);",
    "  return cases.flatMap((item) =>",
    "    (Array.isArray(item.uncertainties) ? item.uncertainties : [])",
    "      .filter((uncertainty) => uncertainty.status !== \"resolved\")",
    "      .map((uncertainty) => ({ caseId: item.id, ...uncertainty })),",
    "  );",
    "}",
    "",
    "export async function learnedPatterns(root = process.cwd()) {",
    "  const cases = await listCases(root);",
    "  return cases.flatMap((item) =>",
    "    (Array.isArray(item.learnings) ? item.learnings : [])",
    "      .map((learning) => ({ caseId: item.id, ...learning })),",
    "  );",
    "}",
    "",
    "export async function status(root = process.cwd()) {",
    "  const cases = await listCases(root);",
    "  return {",
    "    loop,",
    "    caseCount: cases.length,",
    "    unresolvedUncertaintyCount: (await unresolvedUncertainties(root)).length,",
    "    learnedPatternCount: (await learnedPatterns(root)).length,",
    "  };",
    "}",
    "",
    "export async function main(argv = process.argv.slice(2)) {",
    "  const command = argv[0] || \"status\";",
    "  if (command !== \"status\") {",
    "    throw new Error(`unknown command: ${command}`);",
    "  }",
    "  console.log(JSON.stringify(await status(), null, 2));",
    "}",
    "",
    "if (import.meta.url === \"file://\" + process.argv[1]) {",
    "  main().catch((error) => {",
    "    console.error(error.message);",
    "    process.exitCode = 1;",
    "  });",
    "}",
    "",
  ].join("\n");
}

function vasLiteCaseJson(sourceDefaults: ProjectTemplateSourceDefaults): string {
  return JSON.stringify({
    id: "bootstrap",
    status: "needs_review",
    repo: sourceDefaults.repo,
    branch: sourceDefaults.branch,
    baseBranch: sourceDefaults.baseBranch,
    issue: sourceDefaults.issue,
    source: {
      kind: "placeholder",
      url: "",
      range: { start: 0, end: 0 },
    },
    artifacts: {
      frames: "frames/",
      reconstruction: "reconstruction/index.html",
    },
    states: [],
    events: [],
    beats: [
      {
        time: "0.0",
        type: "uncertainty_checkpoint",
        intent: "Replace this bootstrap case with the first reviewed teaching-video segment.",
        confidence: "low",
      },
    ],
    uncertainties: [
      {
        time: "0.0",
        question: "What visual change carries the instructional intent?",
        status: "open",
      },
    ],
    learnings: [],
  }, null, 2) + "\n";
}

function vasLiteCaseNotes(): string {
  return [
    "# Bootstrap Case",
    "",
    "Replace this placeholder with a real clip once the sandbox has source evidence.",
    "",
    "Review checklist:",
    "",
    "- Important stable visual states are named.",
    "- Motion is separated from instructional intent.",
    "- Low-confidence interpretations stay in `uncertainties`.",
    "- Harness runs may write `reports/review-draft.json`; user corrections become `learnings` only after review.",
    "",
  ].join("\n");
}

function vasLiteFramesReadme(): string {
  return [
    "# Frames",
    "",
    "Store sampled frames or contact sheets here. Keep full source media out unless the tenant policy allows it.",
    "",
  ].join("\n");
}

function vasLiteReconstructionHtml(): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "  <title>VAS Lite Reconstruction</title>",
    "  <style>",
    "    body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f8; color: #182027; }",
    "    main { max-width: 760px; margin: 8vh auto; padding: 24px; }",
    "    .stage { border: 1px solid #d8dde3; background: white; padding: 24px; border-radius: 8px; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    "    <div class=\"stage\" data-align-box=\"stage\">",
    "      <h1>VAS Lite Reconstruction</h1>",
    "      <p>Recreate the timing and teaching intent here after evidence is captured.</p>",
    "    </div>",
    "  </main>",
    "  <script>",
    "    window.__vasCollectObservations = () => ({",
    "      text: document.body.innerText,",
    "      boxes: [...document.querySelectorAll('[data-align-box]')].map((node) => ({",
    "        id: node.getAttribute('data-align-box'),",
    "        rect: node.getBoundingClientRect().toJSON ? node.getBoundingClientRect().toJSON() : {},",
    "      })),",
    "    });",
    "  </script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function vasLiteTeachingBeatsJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    beats: [
      {
        name: "anchor_preserving_transition",
        description: "A stable anchor remains visible while the surrounding explanation changes.",
        signals: ["persistent label", "stable formula", "new nearby content"],
      },
      {
        name: "matrix_expansion",
        description: "A compact example expands into a larger rule table or case space.",
        signals: ["table reveal", "row or column growth", "rule coverage increases"],
      },
      {
        name: "source_to_target_mapping",
        description: "A source form maps to a transformed result, often through arrows or motion.",
        signals: ["arrow draw", "paired tokens", "before and after positions"],
      },
      {
        name: "spoken_word_focus",
        description: "A source token is visually emphasized because narration is reading it.",
        signals: ["scale", "sharpen", "highlight", "transcript token match"],
      },
      {
        name: "spoken_answer_focus",
        description: "A transformed result is emphasized because narration is naming the answer.",
        signals: ["result token focus", "answer timing", "post-mapping emphasis"],
      },
      {
        name: "uncertainty_checkpoint",
        description: "The analysis pauses instead of overstating ambiguous instructional intent.",
        signals: ["low confidence", "competing beat types", "user review needed"],
      },
    ],
  }, null, 2) + "\n";
}

function vasLiteLearnedPatterns(): string {
  return [
    "# Learned Patterns",
    "",
    "- Do not treat OCR text changes alone as the semantic layer.",
    "- Separate visual state changes from teaching beats.",
    "- Promote user corrections only after review.",
    "",
  ].join("\n");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
