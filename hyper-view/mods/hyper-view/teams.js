// Ready-made agent teams. Engine per role:
//   Claude Code  - planning, architecture, review, coordination, talking to the human.
//   Codex        - focused implementation: code, scripts, SQL, fast fix-and-test loops.
// Everything here can be changed per agent in the New Agent dialog before launch.

const COMMON = "Coordinate through hp say, keep your tasks up to date (start, progress, review, done) and ask the human before anything destructive.";

export const COMMON_PROMPT = COMMON;

export const TEAMS = [
  {
    id: "software", name: "Software", glyph: "layers", color: "#8aa4c8",
    desc: "Plan, build and test an application",
    agents: [
      { name: "architect", app: "claude", role: "Designs the system, splits work into tasks, reviews results",
        prompt: `You lead this team. Turn the goal into a short plan, create tasks for backend-dev, frontend-dev and qa (hp task add --for ...), and review work that reaches the Review column. ${COMMON}` },
      { name: "backend-dev", app: "codex", role: "Implements APIs, services and data access",
        prompt: `Implement the backend tasks assigned to you. Commit small, working steps and move each task to review when done. ${COMMON}` },
      { name: "frontend-dev", app: "codex", role: "Implements the UI",
        prompt: `Implement the frontend tasks assigned to you, matching the API agreed with backend-dev. Move each task to review when done. ${COMMON}` },
      { name: "qa", app: "claude", role: "Writes and runs tests, verifies features",
        prompt: `Write and run tests for features in review, report bugs as tasks for the right developer, and mark verified tasks done. ${COMMON}` },
    ],
  },
  {
    id: "data", name: "Data", glyph: "database", color: "#5fa89a",
    desc: "Pipelines, models and analysis",
    agents: [
      { name: "data-lead", app: "claude", role: "Plans schemas and pipelines, reviews data quality",
        prompt: `Plan the data model and pipeline for the goal, create tasks for data-engineer and analyst, and review their results. ${COMMON}` },
      { name: "data-engineer", app: "codex", role: "Builds ETL jobs, SQL and pipelines",
        prompt: `Build the pipelines, SQL and jobs assigned to you on the project machines. Document how to run them in the task notes. ${COMMON}` },
      { name: "analyst", app: "claude", role: "Validates data and writes findings",
        prompt: `Validate the data produced by the pipelines, analyse it and write short findings for the human. ${COMMON}` },
    ],
  },
  {
    id: "devops", name: "DevOps", glyph: "server", color: "#c98a62",
    desc: "Infrastructure, deployments and monitoring",
    agents: [
      { name: "sre-lead", app: "claude", role: "Plans infrastructure changes, coordinates rollouts",
        prompt: `Plan infrastructure and deployment work, create tasks for infra-engineer and monitor, and get the human's approval before production changes. ${COMMON}` },
      { name: "infra-engineer", app: "codex", role: "Writes configs, CI/CD and automation",
        prompt: `Implement the infrastructure tasks assigned to you (configs, CI/CD, scripts) using hp ssh / hp sudo on the project machines. ${COMMON}` },
      { name: "monitor", app: "claude", role: "Watches services, logs and resources",
        prompt: `Check the health of every project machine (services, logs, disk, memory) regularly, report problems as tasks and messages. ${COMMON}` },
    ],
  },
  {
    id: "security", name: "Security", glyph: "shield", color: "#c97a7a",
    desc: "Audit, harden and fix vulnerabilities",
    agents: [
      { name: "sec-lead", app: "claude", role: "Plans the audit, prioritises findings",
        prompt: `Plan a security audit of the project and its machines, prioritise findings and create tasks for auditor and fixer. Never change production without the human's approval. ${COMMON}` },
      { name: "auditor", app: "claude", role: "Reviews code, configs and open ports",
        prompt: `Review code, dependencies, configs, users, sudoers and open ports on the project machines (read-only). Report each finding as a task with severity. ${COMMON}` },
      { name: "fixer", app: "codex", role: "Applies patches and hardening",
        prompt: `Fix the findings assigned to you (patches, config hardening, dependency upgrades) and move each to review. ${COMMON}` },
    ],
  },
  {
    id: "research", name: "Research", glyph: "brain", color: "#6f9fd0",
    desc: "Investigate, prototype and document",
    agents: [
      { name: "researcher", app: "claude", role: "Investigates options and writes findings",
        prompt: `Research the goal: compare options, read docs and code, and write concise findings with a recommendation. ${COMMON}` },
      { name: "prototyper", app: "codex", role: "Builds quick proofs of concept",
        prompt: `Build small proofs of concept for the options the researcher picks and report what worked. ${COMMON}` },
      { name: "writer", app: "claude", role: "Turns results into docs and READMEs",
        prompt: `Turn the team's results into clear documentation (README, runbooks, decisions). ${COMMON}` },
    ],
  },
  {
    id: "maintenance", name: "Maintenance", glyph: "zap", color: "#c9b062",
    desc: "Bugs, updates and small fixes",
    agents: [
      { name: "triage", app: "claude", role: "Reproduces bugs and prioritises them",
        prompt: `Collect and reproduce reported bugs, prioritise them and create tasks for the fixer. ${COMMON}` },
      { name: "fixer", app: "codex", role: "Fixes bugs and updates dependencies",
        prompt: `Fix the bugs assigned to you with a test for each, and keep dependencies up to date. ${COMMON}` },
    ],
  },
];

// Your own teams live in ~/.herdr/teams.json (outside the layout folder).
import { readTextFile, writeTextFile } from "herdr";
import { herdrHome } from "./lib.js";
const file = () => `${herdrHome()}/teams.json`;
export async function loadCustomTeams() {
  const text = await readTextFile(file()).catch(() => null);
  try { return { text, teams: text ? JSON.parse(text.replace(/^\uFEFF/, "")).teams ?? [] : [] }; } catch { return { text, teams: [] }; }
}
export async function changeCustomTeams(fn) {
  for (let i = 0; i < 3; i++) {
    const { text, teams } = await loadCustomTeams();
    try { await writeTextFile(file(), JSON.stringify({ teams: fn(teams.slice()) }, null, 2), text ?? null); return true; } catch {}
  }
  return false;
}
