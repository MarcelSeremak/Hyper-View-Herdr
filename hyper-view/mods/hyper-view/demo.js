// In-memory demo data, used only while shared("mp.demo") is true (design previews).
// Nothing here is written to disk.
import { shared } from "herdr";
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const wave = (n, base, amp, seed) => Array.from({ length: n }, (_, i) => Math.max(2, Math.min(98, Math.round(base + amp * Math.sin(i / 2.3 + seed) + amp * 0.5 * Math.sin(i / 0.9 + seed * 2)))));

export const DEMO_MACHINES = [
  { name: "web-frontend-01", host: "10.0.1.11", user: "ubuntu", port: 22, os: "Ubuntu 22.04 LTS", sudo: true },
  { name: "api-server-01", host: "10.0.1.12", user: "ubuntu", port: 22, os: "Ubuntu 22.04 LTS", sudo: true },
  { name: "db-primary", host: "10.0.1.20", user: "debian", port: 22, os: "Debian 12", sudo: false },
  { name: "worker-01", host: "10.0.1.31", user: "ubuntu", port: 22, os: "Ubuntu 24.04 LTS" },
  { name: "cache-01", host: "10.0.1.40", user: "ubuntu", port: 22, os: "Ubuntu 22.04 LTS" },
  { name: "monitor-01", host: "10.0.1.50", user: "ubuntu", port: 22, os: "Ubuntu 24.04 LTS" },
];
export const DEMO_STATS = Object.fromEntries(DEMO_MACHINES.map((m, i) => {
  const h = wave(40, 18 + i * 6, 9, i);
  return [m.name, i === 5 ? { ok: false, err: "Connection timed out", at: now } : {
    ok: true, cpu: h[h.length - 1], ram: 30 + i * 8, disk: 24 + i * 9, rx: 1.2e6 * (i + 1), tx: 4e5 * (i + 1),
    memUsed: (2 + i) * 1e9, memTotal: 16e9, diskUsed: (40 + i * 10) * 1e9, diskTotal: 200e9, os: m.os, cores: 4 + i * 2, uptime: 86400 * (3 + i), cpuHistory: h, at: now,
  }];
}));

const agents = [
  { name: "deploy-agent", role: "Handles deployments and CI/CD", app: "claude", machines: ["web-frontend-01", "api-server-01"], sudo: ["web-frontend-01"], joined: iso(400) },
  { name: "research-agent", role: "Gathers information and analyzes data", app: "codex", machines: [], joined: iso(380) },
  { name: "monitor-agent", role: "Monitors services and infrastructure", app: "claude", machines: [], joined: iso(360) },
  { name: "comm-agent", role: "Coordinates communication between agents", app: "claude", machines: [], joined: iso(300) },
];
export const DEMO_LIVE = { "deploy-agent": "working", "research-agent": "working", "monitor-agent": "idle", "comm-agent": "blocked" };

const task = (id, title, agent, status, extra = {}) => ({ id, title, agent, status, priority: "normal", progress: status === "done" ? 100 : 0, machine: "", created: iso(300 - id * 7), notes: [], history: [{ ts: iso(300 - id * 7), by: "ty", text: "created" }], ...extra });
export const DEMO_PROJECT = {
  name: "E-commerce Platform", slug: "demo-ecommerce", desc: "Multi-VM project for e-commerce infrastructure", status: "active", color: "#8aa4c8",
  dir: "C:/Users/demo/.herdr/projects/demo-ecommerce",
  machines: ["web-frontend-01", "api-server-01", "db-primary", "worker-01", "cache-01"],
  agents,
  tasks: [
    task(1, "Deploy to staging", "deploy-agent", "doing", { desc: "Build the release branch, deploy it to web-frontend-01 and run the smoke tests. Roll back if error rate goes above 1%.", progress: 78, priority: "high", machine: "web-frontend-01", started: iso(40),
      links: [
        { url: "https://gitlab.example.com/shop/storefront/-/commit/3f9a2c1e7b4d", kind: "commit", title: "Bump release to 2.4.0", by: "deploy-agent", ts: iso(35) },
        { url: "https://gitlab.example.com/shop/storefront/-/commit/a81c04d92e55", kind: "commit", title: "Fix smoke test timeout on staging", by: "deploy-agent", ts: iso(24) },
        { url: "https://gitlab.example.com/shop/storefront/-/merge_requests/142", kind: "mr", title: "Release 2.4.0 to staging", by: "deploy-agent", ts: iso(22) },
      ] }),
    task(2, "Analyze market trends", "research-agent", "doing", { desc: "Pull last 30 days of traffic and conversion data, find the top 3 trends and summarise them for the team.", progress: 40 }),
    task(3, "Check system health", "monitor-agent", "done", { completed: iso(20) }),
    task(4, "Share results with team", "comm-agent", "blocked", { desc: "Post the research summary in the team channel once research-agent finishes the analysis.", progress: 50, blocked_reason: "waiting for #2 (research-agent)", after: [2] }),
    task(5, "Optimize database queries", "comm-agent", "todo", { desc: "Find the slowest queries on db-primary (pg_stat_statements), add missing indexes and measure the gain.", priority: "urgent", machine: "db-primary" }),
    task(6, "Set up Redis cache", "deploy-agent", "todo", { desc: "Install Redis on cache-01, configure persistence and point the API session store at it.", machine: "cache-01", after: [1] }),
    task(7, "Write load tests", "research-agent", "backlog", { priority: "low" }),
    task(11, "Review nginx config", "monitor-agent", "review", { desc: "Check the new nginx config: TLS settings, gzip, cache headers and upstream timeouts.", machine: "web-frontend-01", started: iso(60),
      links: [{ url: "https://github.com/example/infra/pull/87", kind: "pr", title: "nginx: TLS 1.3, gzip and upstream timeouts", by: "monitor-agent", ts: iso(55) }] }),
    task(8, "Rotate TLS certificates", "deploy-agent", "done", { completed: iso(90), machine: "web-frontend-01" }),
    task(9, "Configure log shipping", "monitor-agent", "done", { completed: iso(130), machine: "worker-01" }),
    task(10, "Benchmark API latency", "research-agent", "done", { completed: iso(160), machine: "api-server-01" }),
    // Epics: one approved and under way (5 tasks in various states), one planned and waiting for your approval.
    task(12, "Deploy telecom v2.4", "deploy-agent", "doing", { kind: "epic", plan: "approved", priority: "high", progress: 40, started: iso(150),
      desc: "Roll out telecom v2.4 to production: schema migration, API, workers, smoke tests and the switch-over. Done when every region serves v2.4 with error rate below 0.5%." }),
    task(13, "Migrate telecom schema to v2.4", "deploy-agent", "done", { epic: 12, completed: iso(110), machine: "db-primary", desc: "Done when: migration 0051 applied on db-primary, rollback script tested." }),
    task(14, "Build telecom API v2.4 image", "research-agent", "done", { epic: 12, completed: iso(80), after: [13], desc: "Done when: image tagged 2.4.0 in the registry, unit tests green." }),
    task(15, "Roll out API v2.4 to api-server-01", "deploy-agent", "doing", { epic: 12, progress: 55, started: iso(30), machine: "api-server-01", after: [14], desc: "Done when: api-server-01 runs 2.4.0, health checks pass for 15 min." }),
    task(16, "Smoke tests for v2.4", "monitor-agent", "review", { epic: 12, started: iso(25), after: [14], desc: "Done when: the 40 smoke checks pass against staging and production." }),
    task(17, "Switch traffic to v2.4", "comm-agent", "todo", { epic: 12, after: [15, 16], priority: "high", desc: "Done when: 100% of traffic on v2.4, the old pool drained, ty told." }),
    task(18, "Move billing to the EU region", "deploy-agent", "backlog", { kind: "epic", plan: "pending", plan_approval: 8,
      desc: "Billing data and services run in eu-central-1 only. Done when the old region holds no billing data." }),
    task(19, "Provision billing DB in eu-central-1", "deploy-agent", "backlog", { epic: 18, desc: "Done when: replica in sync, lag under 1 s." }),
    task(20, "Copy billing data and verify checksums", "research-agent", "backlog", { epic: 18, after: [19], desc: "Done when: row counts and checksums match." }),
    task(21, "Point billing workers at the EU database", "comm-agent", "backlog", { epic: 18, after: [20], desc: "Done when: workers run 24 h on the EU database without errors." }),
  ],
};
// Code sources (Resources tab) and task worktrees/branches for the lineage graph.
DEMO_PROJECT.sources = [
  { name: "web-frontend", kind: "github", url: "https://github.com/example/web-frontend", branch: "main", secret: "github-bot",
    locations: [{ type: "local", path: "C:\\code\\web-frontend" }, { type: "vm", machine: "web-frontend-01", path: "/srv/web-frontend", deployed: true, service: "nginx" }] },
  { name: "api", kind: "gitlab", url: "https://gitlab.example.com/shop/api", branch: "main", secret: "",
    locations: [{ type: "local", path: "C:\\code\\shop-api" }, { type: "vm", machine: "api-server-01", path: "/opt/shop-api", deployed: true, service: "shop-api" }, { type: "vm", machine: "worker-01", path: "/opt/shop-api", deployed: true, service: "shop-worker" }] },
  { name: "infra", kind: "local-path", url: "", branch: "main", secret: "", locations: [{ type: "local", path: "C:\\code\\infra" }] },
];
{
  const W = "C:/Users/demo/.herdr/projects/demo-ecommerce/work";
  const wt = (id, source, branch, pruned, link) => {
    const x = DEMO_PROJECT.tasks.find((y) => y.id === id);
    if (!x) return;
    x.worktree = { source, branch, path: `${W}/${source}-task-${id}`, machine: "", created: iso(200 - id), ...(pruned ? { pruned: iso(20) } : {}) };
    if (link) x.links = [...(x.links ?? []), { by: x.agent, ts: iso(30), ...link }];
  };
  wt(1, "api", "task/1-deploy-to-staging");
  wt(5, "api", "task/5-optimize-database-queries");
  wt(6, "api", "task/6-set-up-redis-cache", false, { url: "https://gitlab.example.com/shop/api/-/merge_requests/57", kind: "mr", title: "Redis session store" });
  wt(10, "api", "task/10-benchmark-api-latency", true, { url: "https://gitlab.example.com/shop/api/-/merge_requests/51", kind: "mr", title: "Latency benchmarks" });
  wt(8, "web-frontend", "task/8-rotate-tls-certificates", true, { url: "https://github.com/example/web-frontend/pull/312", kind: "pr", title: "Rotate TLS certificates" });
  wt(7, "web-frontend", "task/7-write-load-tests");
  wt(11, "infra", "task/11-review-nginx-config");
  wt(9, "infra", "task/9-configure-log-shipping", true);
}
export const DEMO_SOURCE_STATUS = {
  "web-frontend": { name: "web-frontend", ts: iso(6), remote: { sha: "8c1d2e4", title: "Checkout: lazy-load product images", date: iso(50) },
    locations: [{ type: "local", path: "C:\\code\\web-frontend", ok: true, branch: "main", dirty: 0, ahead: 0, behind: 2 }, { type: "vm", machine: "web-frontend-01", path: "/srv/web-frontend", ok: true, branch: "main", dirty: 0, ahead: 0, behind: 0 }] },
  api: { name: "api", ts: iso(6), locations: [{ type: "local", path: "C:\\code\\shop-api", ok: true, branch: "main", dirty: 3, ahead: 1, behind: 0 },
    { type: "vm", machine: "api-server-01", path: "/opt/shop-api", ok: true, branch: "main", dirty: 0, ahead: 0, behind: 0 }, { type: "vm", machine: "worker-01", path: "/opt/shop-api", ok: true, branch: "main", dirty: 1, ahead: 0, behind: 0 }] },
};
const ev = (min, type, from, to, text, t) =>({ id: min, ts: iso(min), project: "demo-ecommerce", type, from, to, task: t ?? null, text });
export const DEMO_EVENTS = [
  ev(118, "system", "hp", "all", "Project created."),
  ev(95, "message", "comm-agent", "all", "Plan: deploy-agent ships the API first, research-agent profiles it, monitor-agent watches the rollout."),
  ev(70, "tool", "monitor-agent", "all", "ssh monitor-01: systemctl status prometheus"),
  ev(52, "task", "deploy-agent", "all", "#8 Rotate TLS certificates -> done", 8),
  ev(41, "tool", "deploy-agent", "all", "ssh web-frontend-01: git status"),
  ev(40, "tool", "deploy-agent", "all", "ssh web-frontend-01: docker ps"),
  ev(23, "message", "deploy-agent", "all", "I've pushed the latest changes to GitLab. Starting deployment on web-frontend-01…", 1),
  ev(22, "task", "deploy-agent", "all", "Deployment started on web-frontend-01, branch: main", 1),
  ev(21, "tool", "deploy-agent", "all", "sudo web-frontend-01: systemctl reload nginx"),
  ev(20, "message", "monitor-agent", "all", "All services are healthy."),
  ev(18, "message", "research-agent", "comm-agent", "I found a performance issue on the API. CPU usage is spiking during peak hours."),
  ev(15, "message", "comm-agent", "all", "Noted. I'll create a task to optimize the database queries and notify the team."),
  ev(14, "task", "comm-agent", "all", "New task #5: Optimize database queries", 5),
  ev(6, "message", "comm-agent", "ty", "Should I schedule the DB maintenance window tonight?"),
  ev(3, "message", "deploy-agent", "all", "Staging is at 78%. Running smoke tests now."),
];

export const DEMO_USAGE = {
  "deploy-agent": { engine: "claude", input: 182000, output: 64000, cache_read: 2400000, cache_write: 310000, sessions: 3 },
  "research-agent": { engine: "codex", input: 410000, output: 92000, cache_read: 880000, cache_write: 0, sessions: 2 },
  "monitor-agent": { engine: "claude", input: 54000, output: 12000, cache_read: 620000, cache_write: 90000, sessions: 4 },
  "comm-agent": { engine: "claude", input: 96000, output: 41000, cache_read: 1100000, cache_write: 150000, sessions: 2 },
};

const dayAhead = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
export const DEMO_SECRETS = [
  { name: "gitlab-main", kind: "gitlab", provider: "gitlab", type: "pat", host: "gitlab.com", user: "", scopes: ["api", "write_repository"], expires: dayAhead(160), projects: ["demo-ecommerce", "agent-architect"], agents: [], updated: iso(300) },
  { name: "gitlab-deploy", kind: "gitlab", provider: "gitlab", type: "deploy", host: "gitlab.example.com", user: "gitlab+deploy-token-42", scopes: ["read_repository", "read_registry"], expires: dayAhead(9), projects: ["demo-ecommerce"], agents: [], updated: iso(280) },
  { name: "github-bot", kind: "github", provider: "github", type: "fine", host: "github.com", user: "", expires: dayAhead(-3), projects: [], agents: [], updated: iso(200) },
  { name: "aws-staging", kind: "aws", provider: "aws", type: "key", user: "AKIA…", fields: { region: "eu-central-1" }, projects: ["demo-ecommerce"], agents: [], updated: iso(170) },
  { name: "grafana-admin", kind: "password", user: "admin", projects: ["demo-ecommerce"], agents: [], updated: iso(150) },
  { name: "openai-api", kind: "apikey", provider: "apikey", type: "key", host: "https://api.openai.com", user: "", fields: { env: "OPENAI_API_KEY", header: "bearer" }, projects: ["agent-architect"], agents: [], updated: iso(90) },
];
export const DEMO_USES = [
  { ts: iso(44), secret: "gitlab-main", by: "deploy-agent", project: "demo-ecommerce", cmd: "git" },
  { ts: iso(38), secret: "sudo-admin", by: "deploy-agent", project: "demo-ecommerce", cmd: "sudo" },
  { ts: iso(25), secret: "gitlab-deploy", by: "deploy-agent", project: "demo-ecommerce", cmd: "api" },
  { ts: iso(12), secret: "openai-api", by: "research-agent", project: "demo-ecommerce", cmd: "secret" },
];
export const DEMO_CLIPS = [
  { id: "c1", kind: "prompt", title: "Code review checklist", text: "Review the diff for security issues, missing tests, error handling and naming. Report findings as tasks for the author, then move the task to Done.", pinned: true, updated: iso(30) },
  { id: "c2", kind: "command", title: "Restart stack", text: "hp sudo web-frontend-01 --as deploy-agent \"docker compose -f /srv/app/compose.yml up -d --build\"", pinned: false, updated: iso(120) },
  { id: "c3", kind: "note", title: "Staging credentials policy", text: "Staging uses the gitlab-deploy token only. Never push to main without a review task in the Review column.", pinned: false, updated: iso(400) },
  { id: "c4", kind: "prompt", title: "Incident triage", text: "Check every project machine: disk, memory, failed systemd units and the last 200 lines of nginx/app logs. Summarise in hp say --to ty and open tasks for each problem.", pinned: false, updated: iso(800) },
];

// Loose agents: each lives in its own hidden project.
export const DEMO_LOOSE = [
  { name: "agent-architect", slug: "agent-architect", loose: true, desc: "Architecture advisor", status: "active", color: "#5f7f76", dir: "C:/Users/demo/.herdr/projects/agent-architect",
    machines: ["web-frontend-01", "db-primary"], tasks: [],
    agents: [{ name: "architect", app: "claude", role: "Architecture advisor", machines: [], sudo: [], joined: iso(60) }] },
  { name: "agent-infra-scout", slug: "agent-infra-scout", loose: true, desc: "Machine overviews", status: "active", color: "#5f7f76", dir: "C:/Users/demo/.herdr/projects/agent-infra-scout",
    machines: ["web-frontend-01", "api-server-01", "db-primary", "worker-01", "cache-01"], tasks: [],
    agents: [{ name: "infra-scout", app: "codex", role: "Checks every machine and reports", machines: [], sudo: [], joined: iso(30) }] },
];
export const DEMO_LOOSE_EVENTS = {
  "agent-architect": [
    { id: 1, ts: iso(20), project: "agent-architect", type: "message", from: "ty", to: "architect", text: "I'm planning a new booking service. Should it share the Postgres on db-primary or get its own?" },
    { id: 2, ts: iso(19), project: "agent-architect", type: "message", from: "architect", to: "ty", text: "I checked db-primary: 30% CPU, 46% RAM, plenty of disk. Start in the same cluster with a separate database and role; split out once writes exceed ~500/s. I can draft the schema and a migration plan." },
  ],
};

// Merge/pull request reviews for the demo links on tasks #1 and #11 (same shape as `hp mr show --json`).
const counted = (path, diff, status = "modified") => ({
  path, status, diff,
  additions: diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
  deletions: diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
});
const bigDiff = () => ["@@ -1,0 +1,520 @@", ...Array.from({ length: 520 }, (_, i) => `+  { id: ${i + 1}, sku: "SKU-${String(10000 + i)}", price: ${(9.99 + i * 0.5).toFixed(2)} },`)].join("\n");
export const DEMO_MRS = {
  "https://gitlab.example.com/shop/storefront/-/merge_requests/142": {
    provider: "gitlab", title: "Release 2.4.0 to staging", state: "opened", author: "deploy-agent", web_url: "https://gitlab.example.com/shop/storefront/-/merge_requests/142", source: "release/2.4.0", target: "main",
    files: [
      counted("package.json", "@@ -1,6 +1,6 @@\n {\n   \"name\": \"storefront\",\n-  \"version\": \"2.3.4\",\n+  \"version\": \"2.4.0\",\n   \"private\": true,\n   \"scripts\": {"),
      counted("deploy/staging.yml", "@@ -12,9 +12,12 @@ services:\n   web:\n     image: registry.example.com/shop/storefront:${TAG}\n-    replicas: 1\n+    replicas: 2\n     healthcheck:\n-      test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:3000/\"]\n-      timeout: 5s\n+      test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:3000/healthz\"]\n+      timeout: 15s\n+      retries: 5\n+    environment:\n+      NODE_ENV: staging\n     ports:\n       - \"3000:3000\""),
      counted("tests/smoke.spec.ts", "@@ -3,7 +3,7 @@ import { test, expect } from \"@playwright/test\";\n test(\"home page loads\", async ({ page }) => {\n-  await page.goto(\"/\", { timeout: 10000 });\n+  await page.goto(\"/\", { timeout: 30000 });\n   await expect(page.locator(\"h1\")).toBeVisible();\n });\n@@ -20,4 +20,10 @@ test(\"checkout\", async ({ page }) => {\n   await page.click(\"text=Pay\");\n   await expect(page).toHaveURL(/thank-you/);\n });\n+\n+test(\"health endpoint\", async ({ request }) => {\n+  const r = await request.get(\"/healthz\");\n+  expect(r.ok()).toBeTruthy();\n+});"),
      counted("fixtures/products.ts", bigDiff(), "added"),
    ],
  },
  "https://github.com/example/infra/pull/87": {
    provider: "github", title: "nginx: TLS 1.3, gzip and upstream timeouts", state: "open", author: "monitor-agent", web_url: "https://github.com/example/infra/pull/87", source: "nginx-tuning", target: "main",
    files: [
      counted("nginx/conf.d/shop.conf", "@@ -1,14 +1,22 @@\n server {\n     listen 443 ssl http2;\n     server_name shop.example.com;\n-    ssl_protocols TLSv1.2;\n+    ssl_protocols TLSv1.2 TLSv1.3;\n+    ssl_prefer_server_ciphers off;\n+\n+    gzip on;\n+    gzip_types text/css application/javascript application/json image/svg+xml;\n+    gzip_min_length 1024;\n \n     location / {\n         proxy_pass http://api_upstream;\n-        proxy_read_timeout 300s;\n+        proxy_read_timeout 60s;\n+        proxy_connect_timeout 5s;\n     }\n \n     location /static/ {\n-        expires 1h;\n+        expires 7d;\n+        add_header Cache-Control \"public, immutable\";\n     }\n }"),
      counted("nginx/nginx.conf", "@@ -8,6 +8,7 @@ events {\n http {\n     sendfile on;\n     tcp_nopush on;\n+    server_tokens off;\n     keepalive_timeout 65;\n     include /etc/nginx/conf.d/*.conf;\n }"),
    ],
  },
};

// Scale preview (shared "mp.demoBig"): the demo project with 8 agents and ~200 tasks. Built once.
let big = null;
export function demoBigProject() {
  if (big) return big;
  const more = [
    { name: "frontend-agent", role: "Storefront UI", app: "claude", machines: [], joined: iso(280) },
    { name: "api-agent", role: "Backend API", app: "codex", machines: [], joined: iso(270) },
    { name: "qa-agent", role: "Tests and QA", app: "claude", machines: [], joined: iso(260) },
    { name: "docs-agent", role: "Documentation", app: "claude", machines: [], joined: iso(250) },
  ];
  const team = [...agents, ...more];
  const verbs = ["Fix", "Add", "Refactor", "Test", "Document", "Migrate", "Profile", "Review", "Clean up", "Harden"];
  const things = ["checkout flow", "cart API", "search index", "product images", "auth tokens", "order emails", "payment webhooks", "admin panel", "rate limiter", "CDN cache", "inventory sync", "price rules"];
  // Deterministic spread: mostly done, a busy middle, a few blocked.
  const pick = (i) => (i % 10 < 6 ? "done" : ["todo", "todo", "backlog", "doing", "review", "blocked"][i % 6]);
  const prios = ["normal", "normal", "normal", "high", "low", "urgent"];
  const tasks = [...DEMO_PROJECT.tasks];
  for (let i = 0; i < 190; i++) {
    const id = 30 + i, st = pick(i * 7 + 3);
    tasks.push(task(id, `${verbs[i % verbs.length]} ${things[(i * 5) % things.length]} (${id})`, team[(i * 3) % team.length].name, st, {
      priority: prios[i % prios.length], progress: st === "doing" ? (i * 13) % 100 : st === "done" ? 100 : 0,
      desc: i % 3 ? "" : "Short description of what needs to happen and how to check it.",
      completed: st === "done" ? iso(30 + i * 9) : null, started: st === "doing" || st === "review" ? iso(20 + i) : null,
      blocked_reason: st === "blocked" ? "waiting for review from the lead" : "",
    }));
  }
  big = { ...DEMO_PROJECT, agents: team, tasks };
  return big;
}

// One machine lock (hp lock) so the lock badge can be previewed.
export const DEMO_LOCKS = [{ vm: "web-frontend-01", owner: "deploy-agent", project: "demo-ecommerce", reason: "deploying release 2.4", expires: new Date(Date.now() + 25 * 60 * 1000).toISOString() }];

// Fleet preview (shared "mp.demoMany"): 80 machines with varied load, some offline, a few locked.
// demoMachines()/demoStats() pick the small or the big set; both are built once.
let many = null;
function buildMany() {
  const groups = [["web", 14, "demo-ecommerce"], ["api", 12, "demo-ecommerce"], ["worker", 12, "demo-data"], ["db", 6, "demo-data"],
    ["gpu", 8, "demo-ai"], ["ci-runner", 10, "demo-devops"], ["edge-eu", 6, "demo-devops"], ["cache", 6, "demo-ecommerce"]];
  const machines = [...DEMO_MACHINES.map((m) => ({ ...m, demoProjects: ["demo-ecommerce"] }))];
  let k = 0;
  for (const [pre, n, proj] of groups) for (let i = 1; i <= n && machines.length < 80; i++) {
    k++;
    machines.push({ name: `${pre}-${String(i + 1).padStart(2, "0")}`, host: `10.0.${2 + Math.floor(k / 40)}.${(k * 7) % 250 + 2}`, user: "ubuntu", port: 22,
      os: k % 3 ? "Ubuntu 24.04 LTS" : "Debian 12", demoProjects: k % 9 === 0 ? [proj, "demo-devops"] : [proj] });
  }
  const stats = {};
  machines.forEach((m, i) => {
    if (i < DEMO_MACHINES.length) { stats[m.name] = DEMO_STATS[m.name]; return; }
    const r = (x) => { const v = Math.sin(i * 12.9898 + x * 78.233) * 43758.5453; return v - Math.floor(v); };
    if (r(1) < 0.06) { stats[m.name] = { ok: false, err: "Connection timed out", at: now }; return; }
    const base = m.name.startsWith("gpu") ? 62 : m.name.startsWith("ci") ? 48 : 14 + r(2) * 40;
    const h = wave(40, base + (r(3) < 0.12 ? 42 : 0), 6 + r(4) * 10, i);
    stats[m.name] = { ok: true, cpu: h[h.length - 1], ram: Math.round(16 + r(5) * 62), disk: Math.min(97, Math.round(10 + r(6) * 72) + (i % 9 === 4 ? 26 : 0)), rx: 2e5 + r(7) * 4e6, tx: 1e5 + r(8) * 1e6,
      memUsed: 8e9 * r(5), memTotal: 16e9, diskUsed: 200e9 * r(6), diskTotal: 200e9, os: m.os, cores: 2 ** (1 + Math.floor(r(9) * 4)), uptime: 86400 * (1 + Math.floor(r(10) * 60)), cpuHistory: h, at: now };
  });
  return { machines, stats };
}
const manyOn = () => Boolean(shared("mp.demoMany"));
export const demoMachines = () => (manyOn() ? (many ??= buildMany()).machines : DEMO_MACHINES);
export const demoStats = () => (manyOn() ? (many ??= buildMany()).stats : DEMO_STATS);
export const DEMO_MANY_LOCKS = [{ vm: "gpu-03", owner: "research-agent", project: "demo-ai", reason: "training run", expires: new Date(Date.now() + 90 * 60 * 1000).toISOString() },
  { vm: "db-02", owner: "deploy-agent", project: "demo-data", reason: "schema migration", expires: new Date(Date.now() + 15 * 60 * 1000).toISOString() }];

// Agent activity timeline + token history (activity.js shape) for design previews.
let demoAct = null;
export function demoActivity(slug) {
  if (slug !== DEMO_PROJECT.slug) return null;
  if (demoAct) return demoAct;
  const P = { items: [], days: {}, models: {}, tools: {}, toolDays: {}, errors: {}, sessions: {} };
  const pad = (n) => String(n).padStart(2, "0");
  const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const at = (min) => now - min * 60000;
  const it = (a, s, min, k, l, d, x) => P.items.push({ t: at(min), a, s, k, l, ...(d != null ? { d } : {}), ...(x ? { x } : {}) });
  const script = {
    "deploy-agent": [
      ["prompt", "Deploy the release branch to staging and run the smoke tests", 9 * 60e3],
      ["read", "Read deploy/staging.yml", 120], ["bash", "Bash: git status", 900, "ok"], ["edit", "Edit src/api.ts", 300, "ok"],
      ["edit", "Edit src/routes/orders.ts (3 changes)", 400, "ok"], ["test", "Test: npm test → 2 failed, 45 passed", 38000, "fail"],
      ["edit", "Edit tests/smoke.spec.ts", 250, "ok"], ["test", "Test: npm test → 47 passed", 36000, "ok"],
      ["commit", "Commit: Fix smoke test timeout on staging", 1200, "ok"], ["commit", "Git push", 3100, "ok"],
      ["bash", "Bash: hp ssh web-frontend-01 docker compose up -d", 14000, "ok"], ["edit", "Edit nginx/site.conf", null, "run"],
    ],
    "research-agent": [
      ["prompt", "Pull last 30 days of traffic and conversion data", 4 * 60e3],
      ["search", "rg -n \"checkout\" analytics/", 400, "ok"], ["read", "Read analytics/funnel.sql", 90, "ok"], ["web", "Web search: e-commerce conversion benchmarks 2026", 2100, "ok"],
      ["bash", "Bash: python scripts/trends.py --days 30", 8200, "ok"], ["error", "stream disconnected before completion", null, "fail"],
      ["write", "Write reports/trends.md", 200, "ok"], ["bash", "Bash: python scripts/trends.py --plot", null, "run"],
    ],
    "monitor-agent": [
      ["prompt", "Check system health on every machine", 60e3], ["bash", "Bash: hp ssh monitor-01 systemctl status prometheus", 2300, "ok"],
      ["mcp", "MCP grafana: query_dashboard", 1800, "ok"], ["compact", "Context compacted (auto) · 154K tokens"], ["read", "Read logs/nginx-error.log", 140, "ok"],
    ],
    "comm-agent": [
      ["prompt", "Coordinate the release notes with the team", 2 * 60e3], ["read", "Read DECISIONS.md", 80, "ok"], ["bash", "Bash: hp msg --to all \"Release 2.4.0 on staging\"", 700, "ok"],
      ["error", "API error: Overloaded", null, "fail"], ["write", "Write docs/release-2.4.0.md", 300, "ok"],
    ],
  };
  Object.entries(script).forEach(([a, steps], ai) => {
    const app = agents.find((x) => x.name === a)?.app ?? "claude";
    for (let s = 0; s < 3; s++) {
      const sid = `demo-${a}-${s}`;
      const base = 6 + ai * 4 + s * 26 * 60;
      P.sessions[sid] = { a, prov: app, model: app === "codex" ? "gpt-5-codex" : "claude-sonnet-4-5", first: at(base + steps.length * 2) };
      steps.forEach(([k, l, d, x], i) => { if (s === 0 || x !== "run") it(a, sid, base + (steps.length - i) * 2, k, l, d, s === 0 ? x : x === "run" ? "ok" : x); });
    }
    const model = app === "codex" ? "gpt-5-codex" : "claude-sonnet-4-5";
    P.models[a] = { [model]: [0, 0, 0, 0] };
    for (let i = 0; i < 400; i++) {
      const d = new Date(now - i * 86400000);
      const wk = d.getDay() === 0 || d.getDay() === 6;
      if (i > 200 + ai * 30) break;
      const scale = Math.max(0, (wk ? 0.25 : 1) * (1 + 0.6 * Math.sin(i / 5 + ai) + 0.3 * Math.sin(i * 1.3 + ai * 2))) * (ai === 0 ? 1.4 : 1);
      if (!scale) continue;
      const v = [Math.round(18000 * scale), Math.round(9000 * scale), Math.round(320000 * scale), app === "codex" ? 0 : Math.round(40000 * scale)];
      (P.days[dayOf(d.getTime())] ??= {})[`${a}\t${app}`] = v;
      for (let k = 0; k < 4; k++) P.models[a][model][k] += v[k];
    }
  });
  P.items.sort((x, y) => x.t - y.t);
  for (const x of P.items) {
    const tool = { read: "Read", edit: "Edit", write: "Write", bash: "Bash", test: "Bash", commit: "Bash", search: "Grep", web: "WebSearch", mcp: "MCP" }[x.k];
    if (tool) { (P.tools[x.a] ??= {})[tool] = (P.tools[x.a][tool] ?? 0) + 1; const td = (P.toolDays[dayOf(x.t)] ??= {}); td[tool] = (td[tool] ?? 0) + 1; }
    if (x.x === "fail") { const e = (P.errors[dayOf(x.t)] ??= {}); e[x.a] = (e[x.a] ?? 0) + 1; }
  }
  // A month of tool use for the dashboard breakdown.
  for (let i = 1; i < 30; i++) {
    const td = (P.toolDays[dayOf(now - i * 86400000)] ??= {});
    for (const [tool, n] of [["Edit", 34], ["Read", 52], ["Bash", 41], ["Grep", 18], ["Write", 7], ["WebSearch", 3], ["MCP", 5]]) td[tool] = (td[tool] ?? 0) + Math.round(n * (0.6 + 0.4 * Math.sin(i + n)));
  }
  demoAct = P;
  return P;
}
