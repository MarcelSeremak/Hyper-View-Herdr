// Secret catalog: providers (step 1 of the Add Secret wizard) and their token types (step 2),
// with the fields each type needs (step 3). hp.ps1 mirrors the auth rules (Secret-Auth / Run-Env).
// Sources: docs links on every type ("Where do I get this?").
//
// Field: { key, label, ph?, def?, optional?, choices?: [[val, label]], join?: width, store?: "user"|"host" }
//   key "user" / "host" are stored as top-level metadata, everything else under meta.fields.
// secret: the one value that goes to Windows Credential Manager. { label, ph?, multiline? }
// scopes: reference chips the user ticks (documentation only, hp does not check them).

const GL_SCOPES = ["api", "read_api", "read_user", "read_repository", "write_repository", "read_registry", "write_registry",
  "read_virtual_registry", "write_virtual_registry", "create_runner", "manage_runner", "k8s_proxy", "ai_features", "self_rotate", "sudo", "admin_mode"];
const GL_BOT_SCOPES = ["api", "read_api", "read_repository", "write_repository", "read_registry", "write_registry",
  "read_virtual_registry", "write_virtual_registry", "create_runner", "manage_runner", "k8s_proxy", "ai_features", "self_rotate"];
const GL_ROLES = [["guest", "Guest"], ["planner", "Planner"], ["reporter", "Reporter"], ["developer", "Developer"], ["maintainer", "Maintainer"], ["owner", "Owner"]];
const GH_PERMS = ["contents", "pull_requests", "issues", "metadata", "actions", "workflows", "checks", "statuses", "deployments",
  "environments", "secrets", "variables", "administration", "webhooks", "pages", "packages"];
const GH_CLASSIC = ["repo", "workflow", "read:packages", "write:packages", "delete:packages", "read:org", "admin:org", "admin:repo_hook",
  "admin:public_key", "gist", "notifications", "user", "project", "delete_repo"];
const BB_API = ["read:repository:bitbucket", "write:repository:bitbucket", "admin:repository:bitbucket", "read:pullrequest:bitbucket",
  "write:pullrequest:bitbucket", "read:pipeline:bitbucket", "write:pipeline:bitbucket", "read:project:bitbucket", "read:workspace:bitbucket", "read:user:bitbucket"];
const BB_ACCESS = ["repository", "repository:write", "repository:admin", "repository:delete", "pullrequest", "pullrequest:write",
  "pipeline", "pipeline:write", "pipeline:variable", "webhook", "runner", "runner:write"];
const BB_ACCESS_WIDE = [...BB_ACCESS, "project", "project:admin"];
const BB_DC = ["PROJECT_READ", "PROJECT_WRITE", "PROJECT_ADMIN", "REPO_READ", "REPO_WRITE", "REPO_ADMIN"];

const TOKEN = { label: "Token", ph: "paste token" };
const PRIVATE_KEY = { label: "Private key", ph: "-----BEGIN OPENSSH PRIVATE KEY-----", multiline: true };
const host = (def, label = "Host") => ({ key: "host", label, ph: def, def });
const user = (ph = "username", optional = false, label = "Username") => ({ key: "user", label, ph, optional });
const env = (def) => ({ key: "env", label: "Env variable", ph: def, def });

export const SECRET_GROUPS = [
  ["git", "Git hosting"], ["registry", "Registries & packages"], ["cloud", "Cloud"], ["server", "Servers & databases"], ["other", "Other"],
];

export const PROVIDERS = [
  // ------------------------------------------------------------------ Git hosting
  { id: "gitlab", name: "GitLab", group: "git", glyph: "git-merge", color: "#d08a5f", types: [
    { id: "pat", name: "Personal access token", tag: "Common", desc: "Acts as you: API + git over HTTPS, limited by scopes.",
      docs: "https://docs.gitlab.com/user/profile/personal_access_tokens/", fields: [host("gitlab.com")], secret: TOKEN,
      scopes: { label: "Scopes", list: GL_SCOPES }, expires: true },
    { id: "project", name: "Project access token", desc: "Bot user for one project: role + scopes, API and git.",
      docs: "https://docs.gitlab.com/user/project/settings/project_access_tokens/",
      fields: [host("gitlab.com"), { key: "role", label: "Role", choices: GL_ROLES, def: "developer" }], secret: TOKEN,
      scopes: { label: "Scopes", list: GL_BOT_SCOPES }, expires: true },
    { id: "group", name: "Group access token", desc: "Bot user for every project in a group.",
      docs: "https://docs.gitlab.com/user/group/settings/group_access_tokens/",
      fields: [host("gitlab.com"), { key: "role", label: "Role", choices: GL_ROLES, def: "developer" }], secret: TOKEN,
      scopes: { label: "Scopes", list: GL_BOT_SCOPES }, expires: true },
    { id: "deploy", name: "Deploy token", desc: "Clone + registry/package pull or push for one project. No API.",
      docs: "https://docs.gitlab.com/user/project/deploy_tokens/", fields: [host("gitlab.com"), user("gitlab+deploy-token-1")], secret: TOKEN,
      scopes: { label: "Scopes", list: ["read_repository", "read_registry", "write_registry", "read_virtual_registry", "write_virtual_registry", "read_package_registry", "write_package_registry"] }, expires: true },
    { id: "deploykey", name: "Deploy key (SSH)", desc: "SSH key for one repository; read-only unless write access is enabled.",
      docs: "https://docs.gitlab.com/user/project/deploy_keys/", fields: [host("gitlab.com")], secret: PRIVATE_KEY,
      scopes: { label: "Access", list: ["read", "write"] } },
    { id: "trigger", name: "Pipeline trigger token", desc: "Starts pipelines through the API, nothing else.",
      docs: "https://docs.gitlab.com/ci/triggers/", fields: [host("gitlab.com"), { key: "project", label: "Project ID or path", ph: "group/project", optional: true }], secret: TOKEN },
    { id: "runner", name: "Runner authentication token", desc: "Registers a GitLab Runner (glrt-…).",
      docs: "https://docs.gitlab.com/security/tokens/#runner-authentication-tokens", fields: [host("gitlab.com")], secret: TOKEN },
  ] },
  { id: "github", name: "GitHub", group: "git", glyph: "git-branch", color: "#8b949e", types: [
    { id: "fine", name: "Fine-grained token", tag: "Recommended", desc: "Chosen repositories only, one permission at a time.",
      docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
      fields: [host("github.com"), { key: "repos", label: "Repositories", ph: "owner/repo, owner/other or all", optional: true }], secret: TOKEN,
      scopes: { label: "Permissions", list: GH_PERMS }, expires: true },
    { id: "classic", name: "Classic token", desc: "Broad scopes on every repo you can reach. Needed for packages (ghcr.io).",
      docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
      fields: [host("github.com")], secret: TOKEN, scopes: { label: "Scopes", list: GH_CLASSIC }, expires: true },
    { id: "app", name: "GitHub App", desc: "App ID + private key; hp mints 1-hour installation tokens.",
      docs: "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation",
      fields: [host("github.com"), { key: "appId", label: "App ID", ph: "123456" }, { key: "installationId", label: "Installation ID", ph: "7890123", join: 200 }],
      secret: { label: "Private key (.pem)", ph: "-----BEGIN RSA PRIVATE KEY-----", multiline: true }, scopes: { label: "Permissions", list: GH_PERMS } },
    { id: "deploykey", name: "Deploy key (SSH)", desc: "SSH key for one repository; read-only unless write access is allowed.",
      docs: "https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys", fields: [host("github.com")], secret: PRIVATE_KEY,
      scopes: { label: "Access", list: ["read", "write"] } },
  ] },
  { id: "bitbucket", name: "Bitbucket", group: "git", glyph: "bucket", color: "#6f9fd0", types: [
    { id: "api", name: "API token", tag: "Recommended", desc: "Acts as you (Atlassian account); replaces app passwords.",
      docs: "https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/",
      fields: [host("bitbucket.org"), user("Atlassian email", true, "Email")], secret: TOKEN, scopes: { label: "Scopes", list: BB_API }, expires: true },
    { id: "repo", name: "Repository access token", desc: "One repository, no user account; git + API.",
      docs: "https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/", fields: [host("bitbucket.org")], secret: TOKEN,
      scopes: { label: "Scopes", list: BB_ACCESS }, expires: true },
    { id: "project", name: "Project access token", desc: "Every repository in one project; git + API.",
      docs: "https://support.atlassian.com/bitbucket-cloud/docs/using-project-access-tokens/", fields: [host("bitbucket.org")], secret: TOKEN,
      scopes: { label: "Scopes", list: BB_ACCESS_WIDE }, expires: true },
    { id: "workspace", name: "Workspace access token", desc: "Every repository in a workspace (Premium); git + API.",
      docs: "https://support.atlassian.com/bitbucket-cloud/docs/using-workspace-access-tokens/", fields: [host("bitbucket.org")], secret: TOKEN,
      scopes: { label: "Scopes", list: BB_ACCESS_WIDE }, expires: true },
    { id: "dc", name: "Data Center HTTP token", desc: "Self-hosted Bitbucket: personal, project or repository token.",
      docs: "https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html",
      fields: [host("bitbucket.example.com"), { key: "level", label: "Level", choices: [["user", "Personal"], ["project", "Project"], ["repo", "Repository"]], def: "user" }, user("username", true)],
      secret: TOKEN, scopes: { label: "Permissions", list: BB_DC }, expires: true },
    { id: "accesskey", name: "Access key (SSH)", desc: "Read-only SSH key for a repository or project.",
      docs: "https://support.atlassian.com/bitbucket-cloud/docs/set-up-repository-access-keys-on-windows/", fields: [host("bitbucket.org")], secret: PRIVATE_KEY },
    { id: "apppw", name: "App password", tag: "Retired", desc: "Removed by Atlassian in 2026; keep only for old setups.",
      docs: "https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-transitions-to-api-tokens-enhancing-security-with-app-password-deprecation",
      fields: [host("bitbucket.org"), user("bitbucket username")], secret: { label: "App password" } },
  ] },
  { id: "azdo", name: "Azure DevOps", group: "git", glyph: "loop", color: "#5b8fd0", types: [
    { id: "pat", name: "Personal access token", desc: "Azure Repos git + REST API for one or all organizations.",
      docs: "https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate",
      fields: [host("dev.azure.com"), { key: "org", label: "Organization", ph: "my-org", optional: true }], secret: TOKEN,
      scopes: { label: "Scopes", list: ["Code (Read)", "Code (Read & write)", "Build (Read & execute)", "Release (Read, write & execute)", "Work Items (Read & write)", "Packaging (Read & write)"] }, expires: true },
  ] },
  { id: "gitother", name: "Other Git", group: "git", glyph: "git", color: "#76818f", types: [
    { id: "token", name: "Access token", desc: "Gitea, Forgejo, Gogs or any HTTPS git server: user + token.",
      docs: "https://docs.gitea.com/development/api-usage", fields: [host("git.example.com"), user("username", true)], secret: TOKEN, expires: true },
  ] },
  // ------------------------------------------------------------------ Registries & packages
  { id: "docker", name: "Docker Hub", group: "registry", glyph: "container", color: "#5fa0c8", types: [
    { id: "pat", name: "Personal access token", desc: "docker login as you; access picked per token.",
      docs: "https://docs.docker.com/security/access-tokens/",
      fields: [user("docker id"), { key: "access", label: "Access", choices: [["read", "Read"], ["write", "Read & Write"], ["delete", "Read, Write & Delete"]], def: "read" }], secret: TOKEN, expires: true },
    { id: "org", name: "Organization access token", desc: "Owned by the organization, not a person; scoped repos.",
      docs: "https://docs.docker.com/security/access-tokens/", fields: [user("organization name", false, "Organization")], secret: TOKEN, expires: true },
  ] },
  { id: "registry", name: "Registry", group: "registry", glyph: "box", color: "#6fb0bb", types: [
    { id: "ghcr", name: "GitHub (ghcr.io)", desc: "Classic token with read:packages / write:packages.",
      docs: "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
      fields: [host("ghcr.io", "Registry"), user("github username")], secret: TOKEN,
      scopes: { label: "Scopes", list: ["read:packages", "write:packages", "delete:packages"] }, expires: true },
    { id: "gitlab", name: "GitLab registry", desc: "Personal, project or deploy token with read/write_registry.",
      docs: "https://docs.gitlab.com/user/packages/container_registry/authenticate_with_container_registry/",
      fields: [host("registry.gitlab.com", "Registry"), user("username or deploy token user")], secret: TOKEN,
      scopes: { label: "Scopes", list: ["read_registry", "write_registry"] }, expires: true },
    { id: "other", name: "Other registry", desc: "Harbor, Nexus, ACR, Quay… — username + password or token.",
      docs: "https://docs.docker.com/reference/cli/docker/login/", fields: [host("registry.example.com", "Registry"), user()], secret: { label: "Password or token" }, expires: true },
  ] },
  { id: "npm", name: "npm", group: "registry", glyph: "box", color: "#c97a7a", types: [
    { id: "token", name: "Granular access token", desc: "Install or publish packages; write tokens last 90 days max.",
      docs: "https://docs.npmjs.com/about-access-tokens",
      fields: [host("registry.npmjs.org", "Registry"), { key: "access", label: "Access", choices: [["read", "Read-only"], ["write", "Read & write"]], def: "read" }], secret: TOKEN, expires: true },
  ] },
  { id: "pypi", name: "PyPI", group: "registry", glyph: "braces", color: "#d4a35a", types: [
    { id: "token", name: "API token", desc: "Upload packages (username __token__); account-wide or one project.",
      docs: "https://pypi.org/help/#apitoken",
      fields: [host("upload.pypi.org", "Index"), { key: "scope", label: "Scope", choices: [["account", "Entire account"], ["project", "One project"]], def: "project" }, { key: "project", label: "Project", ph: "my-package", optional: true }],
      secret: { label: "Token", ph: "pypi-…" } },
  ] },
  // ------------------------------------------------------------------ Cloud
  { id: "aws", name: "AWS", group: "cloud", glyph: "cloud", color: "#d4a35a", types: [
    { id: "key", name: "Access key", desc: "IAM user key pair for the AWS CLI and SDKs.",
      docs: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
      fields: [{ key: "user", label: "Access key ID", ph: "AKIA…" }, { key: "region", label: "Region", ph: "eu-central-1", def: "eu-central-1", join: 170 }],
      secret: { label: "Secret access key" } },
  ] },
  { id: "azure", name: "Azure", group: "cloud", glyph: "hexagon", color: "#6f9fd0", types: [
    { id: "sp", name: "Service principal", desc: "App registration + client secret for az, Terraform and SDKs.",
      docs: "https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal",
      fields: [{ key: "tenant", label: "Tenant ID", ph: "00000000-0000-…" }, { key: "user", label: "Client (app) ID", ph: "00000000-0000-…" },
        { key: "subscription", label: "Subscription ID", ph: "optional", optional: true }], secret: { label: "Client secret" }, expires: true },
  ] },
  { id: "gcp", name: "Google Cloud", group: "cloud", glyph: "globe", color: "#7fb08a", types: [
    { id: "sa", name: "Service account key", desc: "JSON key file for gcloud and client libraries.",
      docs: "https://cloud.google.com/iam/docs/keys-create-delete",
      fields: [{ key: "project", label: "Project ID", ph: "my-project", optional: true }],
      secret: { label: "Key file (JSON)", ph: "{ \"type\": \"service_account\", … }", multiline: true } },
  ] },
  { id: "k8s", name: "Kubernetes", group: "cloud", glyph: "wheel", color: "#7c8fb5", types: [
    { id: "kubeconfig", name: "Kubeconfig", desc: "Cluster address + credentials for kubectl and helm.",
      docs: "https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/",
      fields: [{ key: "context", label: "Context", ph: "default", optional: true }, { key: "namespace", label: "Namespace", ph: "default", optional: true, join: 200 }],
      secret: { label: "Kubeconfig", ph: "apiVersion: v1\nkind: Config\n…", multiline: true } },
  ] },
  // ------------------------------------------------------------------ Servers & databases
  { id: "ssh", name: "SSH key", group: "server", glyph: "terminal", color: "#5fa89a", types: [
    { id: "key", name: "SSH private key", desc: "Key for ssh / scp / git over SSH (no passphrase).",
      docs: "https://man.openbsd.org/ssh-keygen", fields: [user("deploy", true, "User"), { key: "host", label: "Host", ph: "server.example.com", optional: true }], secret: PRIVATE_KEY },
  ] },
  { id: "db", name: "Database", group: "server", glyph: "database", color: "#a593c2", types: [
    { id: "conn", name: "Database login", desc: "Host, port, database, user and password.",
      fields: [{ key: "engine", label: "Engine", choices: [["postgres", "PostgreSQL"], ["mysql", "MySQL / MariaDB"], ["mssql", "SQL Server"], ["mongodb", "MongoDB"], ["redis", "Redis"]], def: "postgres" },
        { key: "host", label: "Host", ph: "db.example.com" }, { key: "port", label: "Port", ph: "5432", optional: true, join: 110 },
        { key: "database", label: "Database", ph: "app", optional: true }, user("app", true, "User")],
      secret: { label: "Password" } },
  ] },
  { id: "login", name: "Password", group: "server", glyph: "lock", color: "#d4a35a", types: [
    { id: "password", name: "Login & password", desc: "Any service: username + password.",
      fields: [{ key: "host", label: "URL or host", ph: "https://grafana.example.com", optional: true }, user(), env("SERVICE")], secret: { label: "Password" } },
  ] },
  // ------------------------------------------------------------------ Other
  { id: "apikey", name: "API key", group: "other", glyph: "zap", color: "#79b8b0", types: [
    { id: "key", name: "API key", desc: "Any HTTP API: key sent in a header.",
      fields: [{ key: "host", label: "Base URL", ph: "https://api.example.com", optional: true },
        { key: "header", label: "Header", choices: [["bearer", "Authorization: Bearer"], ["x-api-key", "X-API-Key"], ["custom", "Custom"]], def: "bearer" },
        { key: "headerName", label: "Header name", ph: "X-Auth-Token", optional: true, showIf: { header: "custom" } }, env("API_KEY")],
      secret: { label: "Key" }, expires: true },
  ] },
  { id: "webhook", name: "Webhook", group: "other", glyph: "webhook", color: "#c48aa3", types: [
    { id: "secret", name: "Webhook / signing secret", desc: "Shared secret for HMAC signatures (GitHub, GitLab, Stripe…).", fields: [env("WEBHOOK_SECRET")], secret: { label: "Secret" } },
  ] },
  { id: "env", name: ".env bundle", group: "other", glyph: "file-text", color: "#9bb373", types: [
    { id: "bundle", name: ".env bundle", desc: "Several KEY=value lines, injected together.", fields: [], secret: { label: "Variables", ph: "KEY=value\nOTHER_KEY=value", multiline: true } },
  ] },
  { id: "token", name: "Other token", group: "other", glyph: "key", color: "#9aa3ad", types: [
    { id: "generic", name: "Token", desc: "Anything else: one secret value.", fields: [{ key: "host", label: "Used for", ph: "https://… or a note", optional: true }, env("TOKEN")], secret: { label: "Value" }, expires: true },
  ] },
];

// Old kinds (before provider/type) → new taxonomy.
const LEGACY = { gitlab: ["gitlab", "pat"], "gitlab-deploy": ["gitlab", "deploy"], github: ["github", "classic"], password: ["login", "password"], token: ["token", "generic"], cloud: ["token", "generic"] };

export const providerOf = (id) => PROVIDERS.find((p) => p.id === id) ?? null;
export function typeOf(meta) {
  let pid = meta?.provider, tid = meta?.type;
  if (!pid || !tid) [pid, tid] = LEGACY[meta?.kind] ?? ["token", "generic"];
  const prov = providerOf(pid) ?? providerOf("token");
  const type = prov.types.find((x) => x.id === tid) ?? prov.types[0];
  return { prov, type };
}
// Short label for lists: "GitLab · Deploy token".
export function typeLabel(meta) {
  if (meta?.kind === "sudo") return "Sudo";
  const { prov, type } = typeOf(meta);
  if (type.name.toLowerCase().startsWith(prov.name.toLowerCase())) return type.name;
  return prov.types.length === 1 ? (type.name.toLowerCase().includes(prov.name.toLowerCase()) || ["ssh", "db", "login", "apikey", "webhook", "env", "token"].includes(prov.id) ? type.name : `${prov.name} · ${type.name}`) : `${prov.name} · ${type.name}`;
}
// Days until expiry (negative = expired), or null.
export function daysLeft(expires) {
  if (!expires) return null;
  const d = new Date(`${String(expires).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.floor((d - Date.now()) / 86400000);
}
