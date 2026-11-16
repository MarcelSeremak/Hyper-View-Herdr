-- hyper-view editor: Neovim set up as a lean, VS Code-like IDE.
-- Started by the VM "Editor" tab (editor.js) with:
--   nvim --listen \\.\pipe\hv-nvim-<vm> -u <this file> --cmd "let g:hv_host='herdr-<vm>' | let g:hv_state='<json>' | ..."
-- Remote mode (g:hv_host): edits a machine's files over ssh (oil.nvim "oil-ssh://", nothing installed there).
-- Local mode (g:hv_local, demo mode, or plain `nvim -u init.lua` in any folder): a normal local IDE.
--
-- Layout (in the spirit of LazyVim / kickstart.nvim, kept lean for Windows):
--   snacks.nvim  picker (Ctrl+P files, Space / grep, commands), explorer (left file tree),
--                dashboard (start screen with recent files), indent guides, lazygit, terminal
--   gitsigns     git changes in the gutter, blame, hunks
--   lualine + bufferline  status line and file tabs;  which-key  key hints;  autopairs
--   oil.nvim     remote file browsing over ssh (sidebar with Ctrl+B in remote mode)
--   Treesitter   Neovim's bundled parsers (lua, vim, vimdoc, c, query, markdown) always;
--                nvim-treesitter (more languages) only when `tree-sitter` + a C compiler exist.
--   LSP          off by default (fast start). `:HvLsp` turns on mason.nvim + servers (restart to apply).
-- Modeless: files are always in typing (Insert) mode like VS Code; Shift+arrows/mouse select, Ctrl+S/Z/Y/C/X/V,
--   Ctrl+F/H/G/P/B/D, Ctrl+/ … (see "typing mode" and "keys" below). Ctrl+Alt+P opens the Commands menu.
-- Icons: none (JetBrains Mono is not a Nerd Font) — plain text markers everywhere.
-- Plugins live in ~/.herdr/nvim (lazy.nvim, needs git). Without git it still works with built-ins.

local g, o = vim.g, vim.opt
local host = g.hv_host
local is_local = (g.hv_local == 1) or not host
local name = g.hv_name or (host and host:gsub("^herdr%-", "")) or vim.fn.fnamemodify(vim.fn.getcwd(), ":t")
local root = (vim.env.USERPROFILE or vim.env.HOME):gsub("\\", "/") .. "/.herdr/nvim"
local here = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h")
local function exe(bin) return vim.fn.executable(bin) == 1 end
local function slash(p) return ((p or ""):gsub("\\", "/")) end

-- Tools found by editor.js (Neovim's PATH may predate a winget install).
function _G.HvSetTool(_, path)
  if not path or path == "" then return end
  local dir = vim.fn.fnamemodify(path, ":h")
  if not vim.env.PATH:find(dir, 1, true) then vim.env.PATH = dir .. ";" .. vim.env.PATH end
end
if g.hv_rg then HvSetTool("rg", g.hv_rg) end
if g.hv_fd then HvSetTool("fd", g.hv_fd) end

g.mapleader = " "
g.maplocalleader = " "
o.rtp:prepend(here) -- colors/hyper-view.lua
o.termguicolors = true
o.number = true
o.cursorline = true
o.signcolumn = "yes"
o.mouse = "a"
o.mousemodel = "extend"
o.clipboard = "unnamedplus"
o.expandtab = true
o.shiftwidth = 2
o.tabstop = 2
o.smartindent = true
o.wrap = false
o.scrolloff = 6
o.sidescrolloff = 8
o.smoothscroll = false
o.ignorecase = true
o.smartcase = true
o.splitright = true
o.splitbelow = true
o.laststatus = 3
o.showtabline = 2
o.showmode = false
-- Modeless, VS Code-like editing (see "typing mode" below): text files are always in Insert mode,
-- Shift+arrows / mouse select (Select mode: typing replaces the selection), a thin bar cursor, no mode text.
-- Neovim removed 'insertmode'; :h vim_diff suggests `autocmd BufWinEnter * startinsert` plus mappings instead.
o.keymodel = { "startsel", "stopsel" }
o.selectmode = { "mouse", "key" }
o.selection = "exclusive"
o.virtualedit = "onemore"
o.whichwrap:append("<,>,[,]")
o.guicursor = "a:ver25"
o.showcmd = false
o.report = 9999 -- no "N fewer lines" messages after edits
o.ruler = false
o.updatetime = 250
o.timeoutlen = 400
o.undofile = true
o.undodir = root .. "/undo"
o.swapfile = false
o.fillchars = { eob = " ", vert = "│" }
o.pumheight = 12
o.confirm = true
o.completeopt = { "menuone", "noselect", "popup" }
o.shortmess:append("IcW")

-- ------------------------------------------------------------ colors (hyper-view palette, sage accent)
local function palette()
  if vim.o.background == "light" then
    return { bg = "#F5F6F8", bg2 = "#E8EBEF", line = "#ECEFF2", sel = "#D5DAE1", fg = "#303640", muted = "#64748B", dim = "#AAB3BF",
      accent = "#3f7f6f", blue = "#4b6f9e", teal = "#2f7f88", green = "#5c7f3a", amber = "#a06b1f", orange = "#a5582c", red = "#b5524a",
      add = "#dcebd8", del = "#f3dcda", chg = "#dde6f2", txt = "#c6d6ea" }
  end
  return { bg = "#111418", bg2 = "#191E24", line = "#171C21", sel = "#343E49", fg = "#DCE3EB", muted = "#8291A3", dim = "#4a5563",
    accent = "#8cb8a6", blue = "#8aa4c8", teal = "#6fb0bb", green = "#9bb373", amber = "#d4a35a", orange = "#c98a62", red = "#d57c74",
    add = "#24382c", del = "#3d2526", chg = "#25303d", txt = "#33465c" }
end
function _G.HvColors()
  local c = palette()
  vim.cmd("hi clear")
  g.colors_name = "hyper-view"
  local hl = function(n, v) vim.api.nvim_set_hl(0, n, v) end
  hl("Normal", { fg = c.fg, bg = c.bg }); hl("NormalNC", { fg = c.fg, bg = c.bg }); hl("NormalFloat", { fg = c.fg, bg = c.bg2 })
  hl("FloatBorder", { fg = c.sel, bg = c.bg2 }); hl("FloatTitle", { fg = c.accent, bg = c.bg2, bold = true })
  hl("CursorLine", { bg = c.line }); hl("CursorLineNr", { fg = c.fg, bold = true }); hl("LineNr", { fg = c.dim })
  hl("SignColumn", { bg = c.bg }); hl("ColorColumn", { bg = c.bg2 }); hl("WinSeparator", { fg = c.sel })
  hl("Visual", { bg = c.sel }); hl("Search", { fg = c.bg, bg = c.amber }); hl("IncSearch", { fg = c.bg, bg = c.accent }); hl("CurSearch", { fg = c.bg, bg = c.accent })
  hl("MatchParen", { fg = c.accent, bold = true, underline = true })
  hl("Pmenu", { fg = c.fg, bg = c.bg2 }); hl("PmenuSel", { fg = c.bg, bg = c.accent }); hl("PmenuThumb", { bg = c.sel })
  hl("StatusLine", { fg = c.muted, bg = c.bg2 }); hl("StatusLineNC", { fg = c.dim, bg = c.bg2 })
  hl("TabLine", { fg = c.muted, bg = c.bg2 }); hl("TabLineSel", { fg = c.fg, bg = c.bg, bold = true }); hl("TabLineFill", { bg = c.bg2 })
  hl("Directory", { fg = c.blue }); hl("Title", { fg = c.accent, bold = true }); hl("NonText", { fg = c.dim }); hl("Whitespace", { fg = c.sel })
  hl("ErrorMsg", { fg = c.red }); hl("WarningMsg", { fg = c.amber }); hl("MoreMsg", { fg = c.accent }); hl("Question", { fg = c.accent })
  hl("DiffAdd", { bg = c.add }); hl("DiffDelete", { bg = c.del }); hl("DiffChange", { bg = c.chg }); hl("DiffText", { bg = c.txt })
  hl("Added", { fg = c.green }); hl("Changed", { fg = c.amber }); hl("Removed", { fg = c.red })
  hl("Comment", { fg = c.muted, italic = true }); hl("String", { fg = c.green }); hl("Character", { fg = c.green })
  hl("Number", { fg = c.orange }); hl("Boolean", { fg = c.orange }); hl("Constant", { fg = c.orange }); hl("Float", { fg = c.orange })
  hl("Identifier", { fg = c.fg }); hl("Function", { fg = c.teal }); hl("Statement", { fg = c.blue }); hl("Keyword", { fg = c.blue })
  hl("Conditional", { fg = c.blue }); hl("Repeat", { fg = c.blue }); hl("Operator", { fg = c.muted }); hl("Exception", { fg = c.red })
  hl("PreProc", { fg = c.amber }); hl("Include", { fg = c.blue }); hl("Type", { fg = c.amber }); hl("StorageClass", { fg = c.blue })
  hl("Special", { fg = c.accent }); hl("Delimiter", { fg = c.muted }); hl("Todo", { fg = c.bg, bg = c.amber, bold = true }); hl("Error", { fg = c.red })
  hl("@variable", { fg = c.fg }); hl("@variable.member", { fg = c.fg }); hl("@property", { fg = c.fg }); hl("@variable.parameter", { fg = c.fg })
  hl("@function", { link = "Function" }); hl("@function.call", { link = "Function" }); hl("@function.method", { link = "Function" })
  hl("@keyword", { link = "Keyword" }); hl("@type", { link = "Type" }); hl("@type.builtin", { link = "Type" }); hl("@string", { link = "String" })
  hl("@punctuation", { fg = c.muted }); hl("@tag", { fg = c.blue }); hl("@tag.attribute", { fg = c.teal }); hl("@tag.delimiter", { fg = c.muted })
  hl("@constructor", { fg = c.amber }); hl("@module", { fg = c.fg }); hl("@constant.builtin", { fg = c.orange })
  hl("@markup.heading", { fg = c.accent, bold = true }); hl("@markup.link", { fg = c.blue, underline = true })
  hl("@markup.raw", { fg = c.teal }); hl("@markup.strong", { bold = true }); hl("@markup.italic", { italic = true })
  hl("DiagnosticError", { fg = c.red }); hl("DiagnosticWarn", { fg = c.amber }); hl("DiagnosticInfo", { fg = c.blue }); hl("DiagnosticHint", { fg = c.teal })
  hl("DiagnosticUnderlineError", { undercurl = true, sp = c.red }); hl("DiagnosticUnderlineWarn", { undercurl = true, sp = c.amber })
  hl("LspReferenceText", { bg = c.line }); hl("LspReferenceRead", { bg = c.line }); hl("LspReferenceWrite", { bg = c.line })
  hl("HvMode", { fg = c.bg, bg = c.accent, bold = true }); hl("HvHost", { fg = c.accent, bg = c.bg2, bold = true }); hl("HvDim", { fg = c.muted, bg = c.bg2 })
  -- plugins
  hl("OilDir", { fg = c.blue, bold = true }); hl("OilFile", { fg = c.fg })
  hl("GitSignsAdd", { fg = c.green }); hl("GitSignsChange", { fg = c.amber }); hl("GitSignsDelete", { fg = c.red })
  hl("GitSignsCurrentLineBlame", { fg = c.dim, italic = true })
  hl("SnacksIndent", { fg = c.line }); hl("SnacksIndentScope", { fg = c.sel })
  hl("SnacksPicker", { fg = c.fg, bg = c.bg2 }); hl("SnacksPickerBorder", { fg = c.sel, bg = c.bg2 }); hl("SnacksPickerTitle", { fg = c.bg, bg = c.accent, bold = true })
  hl("SnacksPickerMatch", { fg = c.accent, bold = true }); hl("SnacksPickerDir", { fg = c.muted }); hl("SnacksPickerDirectory", { fg = c.blue })
  hl("SnacksPickerPrompt", { fg = c.accent }); hl("SnacksPickerListCursorLine", { bg = c.sel }); hl("SnacksPickerTree", { fg = c.dim })
  hl("SnacksPickerGitStatusModified", { fg = c.amber }); hl("SnacksPickerGitStatusUntracked", { fg = c.green }); hl("SnacksPickerGitStatusAdded", { fg = c.green })
  hl("SnacksPickerGitStatusDeleted", { fg = c.red }); hl("SnacksPickerPathHidden", { fg = c.muted }); hl("SnacksPickerPathIgnored", { fg = c.dim })
  hl("SnacksDashboardHeader", { fg = c.accent, bold = true }); hl("SnacksDashboardKey", { fg = c.amber, bold = true })
  hl("SnacksDashboardDesc", { fg = c.fg }); hl("SnacksDashboardIcon", { fg = c.accent }); hl("SnacksDashboardTitle", { fg = c.accent, bold = true })
  hl("SnacksDashboardFile", { fg = c.fg }); hl("SnacksDashboardDir", { fg = c.muted }); hl("SnacksDashboardFooter", { fg = c.muted })
  hl("SnacksDashboardSpecial", { fg = c.muted })
  hl("WhichKey", { fg = c.amber }); hl("WhichKeyGroup", { fg = c.accent }); hl("WhichKeyDesc", { fg = c.fg }); hl("WhichKeySeparator", { fg = c.dim })
end
vim.cmd.colorscheme("hyper-view") -- also reloaded by Neovim when 'background' changes

-- ------------------------------------------------------------ where the editor is (path bar above it)
local has_oil = false
-- Remote: "/etc/nginx" (absolute), "~/app" or "app" (home) → the URL the explorer opens.
local function url_for(path, isdir)
  path = vim.trim(path or "")
  if path == "" or path == "~" or path == "~/" then path = "" end
  path = path:gsub("^~/", "")
  local u = (has_oil and "oil-ssh://" or "scp://") .. host .. "/" .. path
  if isdir and u:sub(-1) ~= "/" then u = u .. "/" end
  return u
end
local function remote_path(bufname)
  local rest = (bufname or vim.api.nvim_buf_get_name(0)):match("^%a[%w-]*://[^/]+/(.*)$")
  if not rest then return nil end
  if rest:sub(1, 1) == "/" then return rest end
  return rest == "" and "~" or "~/" .. rest
end
local function remote_dir()
  local p = remote_path()
  if not p then return "~" end
  if vim.bo.filetype == "oil" then return (p:gsub("/$", "")) end
  return p:match("^(.*)/[^/]*$") or "~"
end
local last_path
if g.hv_state then pcall(vim.fn.mkdir, vim.fn.fnamemodify(g.hv_state, ":h"), "p") end
local function save_state(p, isdir)
  if not g.hv_state or not p then return end
  last_path = { p, isdir }
  local data = vim.json.encode({ host = host, ["local"] = is_local, path = p, dir = isdir, modified = vim.bo.modified,
    branch = vim.b.gitsigns_head or g.hv_branch, ready = g.hv_ready == true, at = os.time() })
  pcall(vim.fn.writefile, { data }, g.hv_state)
end
local function write_state()
  if is_local then
    local b = vim.api.nvim_buf_get_name(0)
    if vim.bo.buftype == "" and b ~= "" then return save_state(slash(vim.fn.fnamemodify(b, ":p")), false) end
    if not last_path then return save_state(slash(vim.fn.getcwd()), true) end
    return save_state(last_path[1], last_path[2])
  end
  local p = remote_path()
  if p then save_state(p, vim.bo.filetype == "oil" or vim.bo.filetype == "netrw") end
end
vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "BufModifiedSet" }, { callback = function() vim.schedule(write_state) end })
vim.api.nvim_create_autocmd("DirChanged", { callback = function() last_path = nil; vim.schedule(write_state) end })
-- Asks the hyper-view header (editor.js polls "<state>.req"): "term" toggles the terminal under the editor.
local req_n = 0
local function request(kind)
  if not g.hv_state then return false end
  req_n = req_n + 1
  return pcall(vim.fn.writefile, { kind .. " " .. vim.fn.getpid() .. "-" .. req_n }, g.hv_state .. ".req")
end

-- ------------------------------------------------------------ plugins (optional)
local lsp_flag = root .. "/lsp-enabled"
local lsp_on = vim.uv.fs_stat(lsp_flag) ~= nil and vim.fn.has("nvim-0.11") == 1
local cc = exe("zig") or exe("gcc") or exe("clang") or exe("cl")
local ts_plugin = exe("tree-sitter") and cc and vim.fn.has("nvim-0.11") == 1
local lazypath = root .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) and exe("git") then
  vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", "https://github.com/folke/lazy.nvim.git", lazypath })
end
local has_lazy = vim.uv.fs_stat(lazypath) ~= nil

-- Status bar like VS Code's: no mode, same colors in every mode.
local function file_label()
  local p = is_local and slash(vim.fn.expand("%:~:.")) or (remote_path() or vim.fn.expand("%:t"))
  return p .. (vim.bo.modified and "  ●" or "")
end
local function ln_col() return ("Ln %d, Col %d"):format(vim.fn.line("."), vim.fn.charcol(".")) end
local function indent_label() return (vim.bo.expandtab and "Spaces: " or "Tab Size: ") .. vim.fn.shiftwidth() end
local function is_file() local bt = vim.bo.buftype; return bt == "" or bt == "acwrite" end
local function lualine_opts()
  local c = palette()
  local s = { a = { fg = c.fg, bg = c.sel, gui = "bold" }, b = { fg = c.fg, bg = c.bg2 }, c = { fg = c.muted, bg = c.bg2 } }
  return {
    options = { theme = { normal = s, insert = s, visual = s, replace = s, command = s, terminal = s, inactive = s },
      icons_enabled = false, globalstatus = true, component_separators = "", section_separators = "",
      disabled_filetypes = { statusline = { "snacks_dashboard" } } },
    sections = {
      lualine_a = { function() return is_local and name or (host:gsub("^herdr%-", "")) end },
      lualine_b = { { "b:gitsigns_head", fmt = function(b) return b ~= "" and ("git:" .. b) or b end } },
      lualine_c = { { file_label },
        { "diff", source = function() local d = vim.b.gitsigns_status_dict; return d and { added = d.added, modified = d.changed, removed = d.removed } end },
        { "diagnostics", symbols = { error = "E", warn = "W", info = "I", hint = "H" } } },
      lualine_x = { { ln_col, cond = is_file }, { indent_label, cond = is_file }, { "encoding", fmt = string.upper, cond = is_file },
        { function() return ({ unix = "LF", dos = "CRLF", mac = "CR" })[vim.bo.fileformat] or vim.bo.fileformat end, cond = is_file },
        { "filetype", cond = is_file } },
      lualine_y = {}, lualine_z = {} },
  }
end

local wk_keys = { Up = "<Up> ", Down = "<Down> ", Left = "<Left> ", Right = "<Right> ", C = "<C-…> ", M = "<M-…> ", D = "<D-…> ", S = "<S-…> ",
  CR = "<CR> ", Esc = "<Esc> ", ScrollWheelDown = "<ScrollWheelDown> ", ScrollWheelUp = "<ScrollWheelUp> ", NL = "<NL> ", BS = "<BS> ",
  Space = "<Space> ", Tab = "<Tab> ", F1 = "<F1>", F2 = "<F2>", F3 = "<F3>", F4 = "<F4>", F5 = "<F5>", F6 = "<F6>", F7 = "<F7>", F8 = "<F8>",
  F9 = "<F9>", F10 = "<F10>", F11 = "<F11>", F12 = "<F12>" }
local kinds = {}
for _, k in ipairs({ "Array", "Boolean", "Class", "Color", "Control", "Collapsed", "Constant", "Constructor", "Copilot", "Enum", "EnumMember",
  "Event", "Field", "File", "Folder", "Function", "Interface", "Key", "Keyword", "Method", "Module", "Namespace", "Null", "Number", "Object",
  "Operator", "Package", "Property", "Reference", "Snippet", "String", "Struct", "Text", "TypeParameter", "Unit", "Unknown", "Value", "Variable" }) do
  kinds[k] = ""
end

if has_lazy then
  vim.opt.rtp:prepend(lazypath)
  has_oil = true
  local plugins = {
    { "folke/snacks.nvim", priority = 1000, lazy = false, opts = {
      bigfile = { enabled = true },
      quickfile = { enabled = true },
      input = { enabled = true },
      indent = { enabled = true, animate = { enabled = false }, scope = { enabled = true } },
      scroll = { enabled = false },
      notifier = { enabled = true, style = "compact", icons = { error = "E ", warn = "W ", info = "i ", debug = "d ", trace = "t " } },
      explorer = { enabled = is_local, replace_netrw = is_local, trash = false },
      picker = {
        enabled = true,
        prompt = "> ",
        -- Esc closes a picker at once (VS Code), instead of dropping its input box to Normal mode.
        win = { input = { keys = { ["<Esc>"] = { "close", mode = { "n", "i" } } } } },
        layout = { cycle = true, preset = function() return vim.o.columns >= 120 and "default" or "vertical" end },
        icons = {
          files = { enabled = true, dir = "▸ ", dir_open = "▾ ", file = "  " },
          keymaps = { nowait = "" },
          tree = { vertical = "│ ", middle = "├╴", last = "└╴" },
          undo = { saved = "* " },
          ui = { live = "~ ", hidden = "h", ignored = "i", follow = "f", selected = "* ", unselected = "  " },
          git = { enabled = true, commit = "", staged = "+", added = "A", deleted = "D", ignored = "i", modified = "M", renamed = "R", unmerged = "U", untracked = "?" },
          diagnostics = { Error = "E ", Warn = "W ", Hint = "H ", Info = "I " },
          lsp = { unavailable = "-", enabled = "+ ", disabled = "- ", attached = "* " },
          kinds = kinds,
        },
        sources = {
          explorer = {
            hidden = true, ignored = false, follow_file = true, auto_close = false, jump = { close = false },
            layout = { preset = "sidebar", preview = false, auto_hide = { "input" }, layout = { width = 32, position = "left" } },
            win = { input = { keys = { ["<Esc>"] = { "focus_list", mode = { "n", "i" } } } }, list = { keys = {
              ["<c-b>"] = "close",
              ["<c-p>"] = { function() HvAction("files") end, desc = "Find file" },
            } } },
          },
          files = { hidden = true },
          grep = { hidden = true },
        },
      },
      dashboard = {
        enabled = true,
        width = 56,
        preset = {
          header = "hyper-view  ·  " .. name,
          keys = {
            { key = "f", desc = "Find file            Ctrl+P", action = function() HvAction("files") end },
            { key = "g", desc = "Search in files      Ctrl+Alt+F", action = function() HvAction("grep") end },
            { key = "e", desc = "File tree            Ctrl+B", action = function() HvAction("tree") end },
            { key = "s", desc = "Source control", action = function() HvAction("git") end },
            { key = "p", desc = "Commands             Ctrl+Alt+P", action = function() HvAction("commands") end },
            { key = "n", desc = "New file             Ctrl+N", action = function() HvAction("new") end },
            { key = "q", desc = "Quit", action = ":qa" },
          },
        },
        formats = {
          icon = function(item) return { item.icon == "file" and "  " or item.icon == "directory" and "▸ " or (item.icon or ""), width = 2, hl = "icon" } end,
          key = function(item) return { { item.key, hl = "key" } } end,
          file = function(item, ctx)
            local f = vim.fn.fnamemodify(item.file, ":."):gsub("\\", "/")
            if ctx.width and #f > ctx.width then f = "…" .. f:sub(-(ctx.width - 1)) end
            local dir, file = f:match("^(.*/)([^/]+)$")
            return dir and { { dir, hl = "dir" }, { file, hl = "file" } } or { { f, hl = "file" } }
          end,
        },
        sections = {
          { section = "header", padding = 1 },
          { section = "keys", gap = 0, padding = 1 },
          { title = "Recent files", padding = 1 },
          { section = "recent_files", cwd = is_local, limit = 8, indent = 2, padding = 1 },
          { text = { { "Type anywhere like in VS Code · Shift+arrows select · Ctrl+S save · Ctrl+Z undo", hl = "SnacksDashboardFooter" } }, align = "center", padding = 1 },
          { section = "startup", icon = "" },
        },
      },
    } },
    { "stevearc/oil.nvim", lazy = is_local, cmd = "Oil", opts = {
      default_file_explorer = not is_local,
      columns = { "size" },
      view_options = { show_hidden = true },
      skip_confirm_for_simple_edits = true,
      float = { padding = 4, border = "rounded" },
      keymaps = { ["<BS>"] = "actions.parent", ["<C-h>"] = "actions.toggle_hidden", ["<C-b>"] = { callback = function() HvAction("tree") end, desc = "Close tree" },
        ["<CR>"] = { desc = "Open", callback = function()
          local oil = require("oil")
          local e = oil.get_cursor_entry()
          if e and e.type ~= "directory" and vim.w.hv_sidebar then
            local target = oil.get_current_dir() .. e.name
            vim.cmd("wincmd l")
            vim.cmd.edit(vim.fn.fnameescape(target))
          else oil.select() end
        end } },
    } },
    { "nvim-lualine/lualine.nvim", event = "VeryLazy", opts = lualine_opts },
    { "akinsho/bufferline.nvim", event = "VeryLazy", opts = { options = { show_buffer_icons = false, show_buffer_close_icons = true, close_icon = "x",
      buffer_close_icon = "x", modified_icon = "●", separator_style = "thin", always_show_bufferline = true,
      close_command = function(n) Snacks.bufdelete(n) end, right_mouse_command = function(n) Snacks.bufdelete(n) end,
      diagnostics = lsp_on and "nvim_lsp" or false,
      offsets = { { filetype = "snacks_layout_box", text = "EXPLORER", text_align = "left", separator = true },
        { filetype = "oil", text = "EXPLORER", text_align = "left", separator = true } } } } },
    { "lewis6991/gitsigns.nvim", event = { "BufReadPre", "BufNewFile" }, cond = is_local and exe("git"), opts = {
      current_line_blame = false,
      current_line_blame_opts = { delay = 600 },
      on_attach = function(buf)
        local gs = require("gitsigns")
        -- Normal-mode extras only (typing mode never needs them); the Commands menu has the same actions.
        local m = function(l, r, d) vim.keymap.set("n", l, r, { buffer = buf, desc = d }) end
        m("]h", function() gs.nav_hunk("next") end, "Next change")
        m("[h", function() gs.nav_hunk("prev") end, "Previous change")
        m("<leader>gp", gs.preview_hunk, "Preview change")
        m("<leader>gr", gs.reset_hunk, "Revert change")
        m("<leader>gS", gs.stage_hunk, "Stage change")
        m("<leader>gb", gs.toggle_current_line_blame, "Toggle line blame")
        m("<leader>gd", gs.diffthis, "Diff file")
      end,
    } },
    { "windwp/nvim-autopairs", event = "InsertEnter", opts = {} },
    { "folke/which-key.nvim", event = "VeryLazy", opts = { preset = "helix", delay = 400, icons = { mappings = false, keys = wk_keys, breadcrumb = ">", separator = "->", group = "+" },
      win = { border = "rounded" },
      spec = { { "<leader>g", group = "git" } } } },
  }
  if ts_plugin then
    -- nvim-treesitter (main branch) needs the tree-sitter CLI and a C compiler on Windows.
    table.insert(plugins, { "nvim-treesitter/nvim-treesitter", branch = "main", lazy = false, build = ":TSUpdate", config = function()
      pcall(function() require("nvim-treesitter").install({ "typescript", "tsx", "javascript", "css", "html", "json", "go", "python", "yaml", "bash", "lua", "markdown" }) end)
    end })
  end
  if lsp_on then
    local servers = {}
    if exe("node") then vim.list_extend(servers, { "ts_ls", "pyright", "cssls", "jsonls" }) end
    if exe("go") then table.insert(servers, "gopls") end
    table.insert(servers, "lua_ls")
    table.insert(plugins, { "mason-org/mason.nvim", cmd = "Mason", opts = { ui = { border = "rounded", icons = { package_installed = "+", package_pending = "~", package_uninstalled = "-" } } } })
    table.insert(plugins, { "mason-org/mason-lspconfig.nvim", event = { "BufReadPre", "BufNewFile" },
      dependencies = { "mason-org/mason.nvim", "neovim/nvim-lspconfig" },
      opts = { ensure_installed = servers, automatic_enable = true } })
  end
  require("lazy").setup(plugins, { root = root .. "/lazy", lockfile = root .. "/lazy-lock.json",
    install = { missing = true, colorscheme = { "hyper-view" } },
    ui = { border = "rounded", icons = { cmd = "", config = "", event = "", ft = "", init = "", import = "", keys = "", lazy = "", loaded = "+",
      not_loaded = "-", plugin = "", runtime = "", require = "", source = "", start = "", task = "> ", list = { "*", "-", "+", "-" } } },
    change_detection = { enabled = false }, rocks = { enabled = false }, checker = { enabled = false },
    performance = { rtp = { reset = false, disabled_plugins = { "gzip", "tarPlugin", "tohtml", "tutor", "zipPlugin" } } } })
  vim.api.nvim_create_autocmd("ColorScheme", { callback = function()
    if package.loaded.lualine then require("lualine").setup(lualine_opts()) end
  end })
else
  -- Built-ins only: netrw tree, a simple status line.
  g.netrw_banner = 0
  g.netrw_liststyle = 3
  g.netrw_winsize = 22
  function _G.HvStatus()
    return "%#HvHost# " .. name .. " %#HvDim# " .. ((not is_local and remote_path()) or "%f") .. " %m%=" .. ln_col() .. "   "
      .. indent_label() .. "   " .. string.upper(vim.bo.fileencoding ~= "" and vim.bo.fileencoding or "utf-8") .. "   %Y  "
  end
  o.statusline = "%!v:lua.HvStatus()"
end
local has_snacks = has_lazy and pcall(require, "snacks")

-- ------------------------------------------------------------ syntax: Treesitter where a parser exists
-- Neovim bundles parsers for lua, vim, vimdoc, c, query and markdown; nvim-treesitter adds the rest
-- (only with a C compiler). Other languages keep Vim's regex highlighting.
vim.api.nvim_create_autocmd("FileType", { callback = function(ev)
  if vim.bo[ev.buf].buftype ~= "" then return end
  pcall(vim.treesitter.start, ev.buf)
end })

-- ------------------------------------------------------------ diagnostics + LSP (when on)
vim.diagnostic.config({ severity_sort = true, float = { border = "rounded" }, virtual_text = { prefix = "●", spacing = 2 },
  signs = { text = { [vim.diagnostic.severity.ERROR] = "E", [vim.diagnostic.severity.WARN] = "W", [vim.diagnostic.severity.INFO] = "I", [vim.diagnostic.severity.HINT] = "H" } } })
vim.api.nvim_create_autocmd("LspAttach", { callback = function(ev)
  local client = vim.lsp.get_client_by_id(ev.data.client_id)
  local ok, sup = pcall(function() return client and client:supports_method("textDocument/completion") end)
  if ok and sup and vim.lsp.completion then
    vim.lsp.completion.enable(true, client.id, ev.buf, { autotrigger = true })
  end
end })
vim.api.nvim_create_user_command("HvLsp", function()
  if vim.uv.fs_stat(lsp_flag) then os.remove(lsp_flag); vim.notify("Language servers: off (restart the editor)")
  else
    vim.fn.mkdir(root, "p"); vim.fn.writefile({ "1" }, lsp_flag)
    vim.notify("Language servers: on (restart the editor; servers install once via Mason)")
  end
end, { desc = "Toggle language servers (LSP)" })
local function has_lsp() return #vim.lsp.get_clients({ bufnr = 0 }) > 0 end
local function need_lsp() vim.notify("No language server here. Turn them on in Commands (Ctrl+Alt+P) > Language servers, then restart.", vim.log.levels.INFO) end

-- ------------------------------------------------------------ actions (keys, dashboard, hyper-view header)
local function in_git() return exe("git") and vim.fn.finddir(".git", vim.fn.getcwd() .. ";") ~= "" end
local function sh_quote(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local function remote_cd(dir)
  if dir == "~" or dir == "" then return "cd ~" end
  if dir:sub(1, 2) == "~/" then return "cd ~/" .. sh_quote(dir:sub(3)) end
  return "cd " .. sh_quote(dir)
end
local function proc_picker(opts)
  return Snacks.picker.pick({
    title = opts.title, layout = { preset = opts.layout or "vscode" }, format = "text", preview = "none",
    finder = function(fopts, ctx)
      return require("snacks.picker.source.proc").proc(ctx:opts({ cmd = opts.cmd, args = opts.args, notify = true }), ctx)
    end,
    confirm = function(picker, item) picker:close(); if item then opts.open(item.text) end end,
  })
end
local function remote_join(dir, rel)
  rel = rel:gsub("^%./", "")
  if dir == "~" then return "~/" .. rel end
  return dir .. "/" .. rel
end

-- The editing window (not the tree, a picker or a float); the start screen counts.
local function main_win()
  local function ok(w)
    if not vim.api.nvim_win_is_valid(w) or vim.api.nvim_win_get_config(w).relative ~= "" then return false end
    local b = vim.api.nvim_win_get_buf(w)
    return vim.bo[b].buftype == "" or vim.bo[b].filetype == "snacks_dashboard"
  end
  local cur = vim.api.nvim_get_current_win()
  if ok(cur) then return cur end
  local prev = vim.fn.win_getid(vim.fn.winnr("#"))
  if prev ~= 0 and ok(prev) then return prev end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do if ok(w) then return w end end
end

local function tree_toggle()
  if is_local then
    if not has_snacks then return vim.cmd("Lexplore") end
    local open = Snacks.picker.get({ source = "explorer" })
    if #open > 0 then for _, p in ipairs(open) do p:close() end else Snacks.explorer() end
    return
  end
  -- Remote: oil in a left sidebar.
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.w[w].hv_sidebar then return vim.api.nvim_win_close(w, true) end
  end
  local dir = remote_dir()
  vim.cmd("topleft 32vsplit")
  vim.w.hv_sidebar = true
  vim.wo.winfixwidth = true
  vim.wo.number = false
  if has_oil then require("oil").open(url_for(dir, true)) else vim.cmd("edit " .. vim.fn.fnameescape(url_for(dir, true))) end
end

local function find_files()
  if not has_snacks then return vim.cmd("browse oldfiles") end
  if not is_local then
    local dir = remote_dir()
    return proc_picker({ title = "Files on " .. name .. " (" .. dir .. ")", cmd = "ssh", args = { host,
      remote_cd(dir) .. " && find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -5000" },
      open = function(rel) vim.cmd.edit(vim.fn.fnameescape(url_for(remote_join(dir, rel)))) end })
  end
  if exe("rg") or exe("fd") then return Snacks.picker.files({ layout = { preset = "vscode" } }) end
  if in_git() then return Snacks.picker.git_files({ layout = { preset = "vscode" }, untracked = true }) end
  -- Last resort: walk the folder (no rg/fd/git).
  local items = {}
  for f, t in vim.fs.dir(".", { depth = 8, skip = function(d) return not d:match("node_modules") and not d:match("^%.git$") end }) do
    if t == "file" then items[#items + 1] = { text = f, file = f } end
    if #items > 5000 then break end
  end
  Snacks.picker.pick({ title = "Files", items = items, format = "file", layout = { preset = "vscode" } })
end

local function grep()
  if not has_snacks then return vim.notify("Search needs the editor plugins (git).", vim.log.levels.WARN) end
  if not is_local then
    local dir = remote_dir()
    return Snacks.input({ prompt = "Search on " .. name .. " in " .. dir }, function(q)
      if not q or q == "" then return end
      proc_picker({ title = "Search: " .. q, layout = "default", cmd = "ssh", args = { host,
        remote_cd(dir) .. " && grep -rnI --exclude-dir=.git --exclude-dir=node_modules -e " .. sh_quote(q) .. " . 2>/dev/null | head -1000" },
        open = function(line)
          local f, l = line:match("^(.-):(%d+):")
          if f then vim.cmd("edit +" .. l .. " " .. vim.fn.fnameescape(url_for(remote_join(dir, f)))) end
        end })
    end)
  end
  if exe("rg") then return Snacks.picker.grep() end
  if in_git() then return Snacks.picker.git_grep({ untracked = true }) end
  Snacks.input({ prompt = "Search in files (install ripgrep for live search)" }, function(q)
    if not q or q == "" then return end
    vim.cmd("silent! vimgrep /\\V" .. vim.fn.escape(q, "/\\") .. "/gj **/*")
    Snacks.picker.qflist()
  end)
end

local function git_ui()
  if has_snacks and exe("lazygit") and is_local then return Snacks.lazygit() end
  if has_snacks and is_local and in_git() then return Snacks.picker.git_status() end
  vim.notify(is_local and "Not a git repository." or "Git view works for local folders; use the terminal (Ctrl+`) on the machine.")
end

local function terminal_toggle()
  if request("term") then return end
  if has_snacks then Snacks.terminal.toggle(nil, { win = { position = "bottom", height = 0.3 } }) else vim.cmd("botright 12split | terminal") end
end

local actions = {
  tree = tree_toggle, files = find_files, grep = grep, git = git_ui, term = terminal_toggle,
  commands = function() if has_snacks then Snacks.picker.commands({ layout = { preset = "vscode" } }) else vim.api.nvim_feedkeys(":", "n", false) end end,
  recent = function() if has_snacks then Snacks.picker.recent({ filter = { cwd = is_local } }) else vim.cmd("browse oldfiles") end end,
  buffers = function() if has_snacks then Snacks.picker.buffers({ layout = { preset = "vscode" } }) end end,
  symbols = function() if has_snacks and has_lsp() then Snacks.picker.lsp_symbols() else need_lsp() end end,
  bar = function() request("bar") end,
}
function _G.HvAction(n) local f = actions[n]; if f then f() end end

-- Opens a path from the header: a folder becomes the tree's root (local) or opens in oil (remote).
function _G.HvOpen(path)
  path = vim.trim(path or "")
  if is_local then
    if path == "" or path == "~" then path = vim.env.USERPROFILE or vim.env.HOME end
    local full = vim.fn.fnamemodify(vim.fn.expand(path), ":p")
    if vim.fn.isdirectory(full) == 1 then
      vim.cmd.cd(vim.fn.fnameescape(full))
      if has_snacks then
        for _, p in ipairs(Snacks.picker.get({ source = "explorer" })) do p:close() end
        Snacks.explorer({ cwd = full })
      else vim.cmd("Lexplore " .. vim.fn.fnameescape(full)) end
      save_state((slash(full):gsub("/$", "")), true)
    else
      local w = main_win()
      if w then vim.api.nvim_set_current_win(w) end
      vim.cmd.edit(vim.fn.fnameescape(full))
    end
    return
  end
  local shown = path == "" and "~" or path
  save_state(shown, true)
  if has_oil then require("oil").open(url_for(path, true)) else vim.cmd("edit " .. vim.fn.fnameescape(url_for(path, true))) end
end

-- ------------------------------------------------------------ typing mode (modeless, like VS Code)
-- Neovim removed 'insertmode'; :h vim_diff ("nvim-removed") suggests `autocmd BufWinEnter * startinsert`
-- plus mappings instead. Here: text buffers are always in Insert mode, selections are Select mode
-- ('keymodel' startsel/stopsel, 'selectmode' key,mouse: typing replaces them), every key below works from
-- Insert/Select mode via <Cmd>/Lua (never via <Esc>), and any slip into Normal mode in a text buffer goes
-- straight back to typing. The start screen, file tree, pickers and terminal keep their own modes.
local H = {}
_G.HvEdit = H
local api = vim.api
local function feed(s) api.nvim_feedkeys(api.nvim_replace_termcodes(s, true, false, true), "n", false) end
local skip_ft = { oil = true, lazy = true, mason = true, qf = true, netrw = true, help = true, checkhealth = true }

-- A text window: a file buffer (remote ones are "acwrite"), not the tree, a picker, the start screen or a terminal.
local function is_text(win)
  win = win or api.nvim_get_current_win()
  if not api.nvim_win_is_valid(win) or api.nvim_win_get_config(win).relative ~= "" then return false end
  local b = api.nvim_win_get_buf(win)
  local bt, ft = vim.bo[b].buftype, vim.bo[b].filetype
  if bt ~= "" and bt ~= "acwrite" then return false end
  return vim.bo[b].modifiable and not skip_ft[ft] and not ft:match("^snacks")
end
local function sync_mode()
  if vim.fn.getcmdtype() ~= "" or vim.fn.reg_recording() ~= "" or vim.fn.reg_executing() ~= "" then return end
  local m = api.nvim_get_mode()
  if m.blocking then return end
  if is_text() then
    if m.mode == "n" then vim.cmd("startinsert") end
  elseif m.mode:sub(1, 1) == "i" then
    local b = api.nvim_get_current_buf()
    local bt, ft = vim.bo[b].buftype, vim.bo[b].filetype
    if bt ~= "prompt" and bt ~= "terminal" and not ft:match("input") and (not vim.bo[b].modifiable or skip_ft[ft] or ft:match("^snacks")) then
      vim.cmd("stopinsert")
    end
  end
end
H.sync = sync_mode
local function later() vim.schedule(sync_mode); vim.defer_fn(sync_mode, 80) end
local grp = api.nvim_create_augroup("hv_typing", { clear = true })
api.nvim_create_autocmd({ "BufEnter", "BufWinEnter", "WinEnter", "FocusGained", "TermLeave" }, { group = grp, callback = later })
api.nvim_create_autocmd("ModeChanged", { group = grp, pattern = "*:n", callback = later })
-- Undo steps like VS Code: a pause in typing starts a new step (one Insert session would otherwise be one step).
api.nvim_create_autocmd("CursorHoldI", { group = grp, callback = function()
  if vim.fn.pumvisible() == 0 and is_text() then feed("<C-g>u") end
end })

-- ---------------- selection helpers
local vmode = { s = "v", S = "V", ["\19"] = "\22", v = "v", V = "V", ["\22"] = "\22" }
local function in_sel() return vmode[api.nvim_get_mode().mode] ~= nil end
local function sel_text()
  local m = vmode[api.nvim_get_mode().mode]
  if not m then return nil end
  local ok, lines = pcall(vim.fn.getregion, vim.fn.getpos("v"), vim.fn.getpos("."), { type = m })
  if not ok then return nil end
  return lines, (m == "V" and "V" or m == "\22" and "b" or "v")
end
-- Selects rows sr..er (1-based), byte columns sc..ec (0-based, end exclusive) in Select mode.
local function select_range(sr, sc, er, ec)
  local m = api.nvim_get_mode().mode
  local from = ("<Cmd>call cursor(%d,%d)<CR>"):format(sr, sc + 1)
  local to = ("<Cmd>call cursor(%d,%d)<CR>"):format(er, ec + 1)
  if vmode[m] then
    local pre = ({ s = "<C-g>", S = "<C-g>v", ["\19"] = "<C-g>v", v = "", V = "v", ["\22"] = "v" })[m]
    feed(pre .. from .. "o" .. to .. "<C-g>")
  else
    feed("<C-\\><C-n>" .. from .. "v" .. to .. "<C-g>")
  end
end
local function cursor() return unpack(api.nvim_win_get_cursor(0)) end
local function setreg(lines, kind)
  if not pcall(vim.fn.setreg, "+", lines, kind) then vim.fn.setreg('"', lines, kind) end
end

-- ---------------- editing actions
function H.copy()
  local lines, kind = sel_text()
  if lines then setreg(lines, kind) else setreg({ api.nvim_get_current_line() }, "V") end
end
function H.cut_line()
  H.copy()
  local r, c = cursor()
  if api.nvim_buf_line_count(0) == 1 then api.nvim_buf_set_lines(0, 0, 1, false, { "" })
  else api.nvim_buf_set_lines(0, r - 1, r, false, {}) end
  local nr = math.min(r, api.nvim_buf_line_count(0))
  api.nvim_win_set_cursor(0, { nr, math.min(c, #(api.nvim_buf_get_lines(0, nr - 1, nr, false)[1] or "")) })
end
-- Keys that replace a selection: Select mode → (Visual) → change into the black hole register.
local function del_sel(prefix, suffix)
  return function()
    local m = api.nvim_get_mode().mode
    local g = (m == "s" or m == "S" or m == "\19") and "<C-g>" or ""
    return (prefix or "") .. g .. '"_c' .. (suffix or "")
  end
end
function H.select_all()
  local n = api.nvim_buf_line_count(0)
  select_range(1, 0, n, #(api.nvim_buf_get_lines(0, n - 1, n, false)[1] or ""))
end
-- Ctrl+D: select the word at the cursor; with a selection, select its next occurrence.
function H.select_word()
  if in_sel() then
    local lines = sel_text()
    if not lines or #lines ~= 1 or lines[1] == "" then return end
    local needle = lines[1]
    local a, b = vim.fn.getpos("v"), vim.fn.getpos(".")
    if a[2] > b[2] or (a[2] == b[2] and a[3] > b[3]) then b = a end
    local all = api.nvim_buf_get_lines(0, 0, -1, false)
    local n = #all
    for i = 0, n do
      local r = ((b[2] - 1 + i) % n) + 1
      local s = all[r]:find(needle, i == 0 and b[3] or 1, true)
      if s then return select_range(r, s - 1, r, s - 1 + #needle) end
    end
    return
  end
  local r, c = cursor()
  for s, e in api.nvim_get_current_line():gmatch("()[%w_\128-\255]+()") do
    if c >= s - 1 and c <= e - 1 then return select_range(r, s - 1, r, e - 1) end
  end
end
function H.comment()
  local a, b = vim.fn.line("."), vim.fn.line(".")
  local sel = in_sel()
  if sel then a = vim.fn.line("v") end
  if a > b then a, b = b, a end
  local ok, cm = pcall(require, "vim._comment")
  if not ok or not cm.toggle_lines then return end
  local r, c = cursor()
  local before = #api.nvim_get_current_line()
  cm.toggle_lines(a, b, { r, c })
  if not sel then api.nvim_win_set_cursor(0, { r, math.max(0, c + #api.nvim_get_current_line() - before) }) end
end
function H.move(d)
  local r, c = cursor()
  if (d < 0 and r == 1) or (d > 0 and r == api.nvim_buf_line_count(0)) then return end
  vim.cmd(d < 0 and "silent move .-2" or "silent move .+1")
  api.nvim_win_set_cursor(0, { r + d, c })
end
function H.dup(d)
  local r, c = cursor()
  api.nvim_buf_set_lines(0, r, r, false, { api.nvim_get_current_line() })
  api.nvim_win_set_cursor(0, { d > 0 and r + 1 or r, c })
end
function H.home()
  local r, c = cursor()
  local first = (api.nvim_get_current_line():find("%S") or 1) - 1
  api.nvim_win_set_cursor(0, { r, c == first and 0 or first })
end
function H.del_word_right()
  local r, c = cursor()
  local line = api.nvim_get_current_line()
  if c >= #line then
    if r < api.nvim_buf_line_count(0) then api.nvim_buf_set_text(0, r - 1, #line, r, 0, { "" }) end
    return
  end
  local rest = line:sub(c + 1)
  local n = rest:match("^%s*[%w_\128-\255]+()") or rest:match("^%s*[^%w_%s\128-\255]+()") or rest:match("^%s+()") or 2
  api.nvim_buf_set_text(0, r - 1, c, r - 1, c + n - 1, { "" })
end
function H.esc()
  local cur = api.nvim_get_current_win()
  for _, w in ipairs(api.nvim_list_wins()) do
    if w ~= cur and api.nvim_win_get_config(w).relative ~= "" and not vim.bo[api.nvim_win_get_buf(w)].filetype:match("^snacks") then
      pcall(api.nvim_win_close, w, false)
    end
  end
  if has_snacks then pcall(Snacks.notifier.hide) end
end
local function errmsg(e) return (tostring(e):gsub("^.*Vim%(%w+%):", "")) end
function H.save_as()
  vim.ui.input({ prompt = "Save as", default = is_local and (slash(vim.fn.getcwd()) .. "/") or "", completion = "file" }, function(p)
    if not p or p == "" then return end
    if not is_local and not p:match("^%a[%w-]*://") then p = url_for(p, false) end
    local ok, e = pcall(vim.cmd, "saveas " .. vim.fn.fnameescape(p))
    if not ok then vim.notify(errmsg(e), vim.log.levels.ERROR) end
  end)
end
function H.save()
  if not is_text() then return end
  if api.nvim_buf_get_name(0) == "" then return H.save_as() end
  local ok, e = pcall(vim.cmd, "write")
  if not ok then vim.notify(errmsg(e), vim.log.levels.ERROR) end
end
function H.goto_line()
  local win = api.nvim_get_current_win()
  local n = api.nvim_buf_line_count(0)
  vim.ui.input({ prompt = ("Go to line (1-%d), or line:column"):format(n) }, function(s)
    local l, c = (s or ""):match("^%s*(%d+)%s*[:,]?%s*(%d*)")
    if not l or not api.nvim_win_is_valid(win) then return end
    api.nvim_set_current_win(win)
    local row = math.max(1, math.min(tonumber(l), api.nvim_buf_line_count(0)))
    local len = #(api.nvim_buf_get_lines(0, row - 1, row, false)[1] or "")
    api.nvim_win_set_cursor(win, { row, math.min(len, c ~= "" and (tonumber(c) - 1) or 0) })
    pcall(vim.cmd, "normal! zz")
  end)
end
-- Find: F3 / Shift+F3 select the next / previous match of the last search.
function H.find_next(dir, row)
  local pat = vim.fn.getreg("/")
  if pat == "" then return H.find() end
  local cur = api.nvim_win_get_cursor(0)
  if row then api.nvim_win_set_cursor(0, { row, 0 })
  elseif in_sel() then
    local a, b = vim.fn.getpos("v"), vim.fn.getpos(".")
    local first = (a[2] < b[2] or (a[2] == b[2] and a[3] <= b[3]))
    local p = (dir < 0) == first and a or b
    vim.fn.cursor(p[2], p[3])
  end
  local p = vim.fn.searchpos(pat, (dir < 0 and "b" or "") .. (row and "c" or "") .. "w")
  if p[1] == 0 then
    pcall(api.nvim_win_set_cursor, 0, cur)
    return vim.notify("No results", vim.log.levels.INFO)
  end
  local e = vim.fn.searchpos(pat, "cenW")
  local eline = api.nvim_buf_get_lines(0, e[1] - 1, e[1], false)[1] or ""
  local ok, extra = pcall(vim.str_utf_end, eline, e[2])
  select_range(p[1], p[2] - 1, e[1], e[2] + (ok and extra or 0))
end
function H.search(text, row)
  text = vim.trim(text or "")
  if text == "" then
    if row then api.nvim_win_set_cursor(0, { row, 0 }) end
    return
  end
  vim.fn.setreg("/", "\\c\\V" .. vim.fn.escape(text, "\\/"))
  vim.v.hlsearch = 1
  H.find_next(1, row)
end
function H.find()
  local lines = sel_text()
  local q = lines and #lines == 1 and lines[1] or nil
  if not has_snacks then
    return vim.ui.input({ prompt = "Find", default = q }, function(s) if s and s ~= "" then H.search(s) end end)
  end
  local win = api.nvim_get_current_win()
  Snacks.picker.lines({ pattern = q, confirm = function(picker, item)
    local text = picker.input and picker.input:get() or ""
    picker:close()
    if not item then return end
    vim.schedule(function()
      if api.nvim_win_is_valid(win) then api.nvim_set_current_win(win) end
      H.search(text, (item.pos and item.pos[1]) or item.lnum or 1)
    end)
  end })
end
function H.replace()
  local lines = sel_text()
  local q = lines and #lines == 1 and lines[1] or vim.fn.expand("<cword>")
  local win = api.nvim_get_current_win()
  vim.ui.input({ prompt = "Replace in this file: find", default = q }, function(find)
    if not find or find == "" then return end
    vim.ui.input({ prompt = ('Replace "%s" with'):format(find) }, function(rep)
      if rep == nil or not api.nvim_win_is_valid(win) then return end
      api.nvim_set_current_win(win)
      local pat = "\\c\\V" .. vim.fn.escape(find, "\\/")
      local ok, cnt = pcall(vim.fn.searchcount, { pattern = pat, maxcount = 0, recompute = true })
      local n = ok and type(cnt) == "table" and cnt.total or 0
      if n == 0 then return vim.notify(('"%s" is not in this file'):format(find)) end
      local view = vim.fn.winsaveview()
      local done, e = pcall(vim.cmd, ("keeppatterns %%s/%s/%s/ge"):format(pat, vim.fn.escape(rep, "\\/&~")))
      vim.fn.winrestview(view)
      if done then vim.notify(("Replaced %d"):format(n)) else vim.notify(errmsg(e), vim.log.levels.ERROR) end
    end)
  end)
end
local close_buf = function() if has_snacks then Snacks.bufdelete() else vim.cmd("bdelete") end end
local function cycle(d)
  if not pcall(vim.cmd, d > 0 and "BufferLineCycleNext" or "BufferLineCyclePrev") then vim.cmd(d > 0 and "bnext" or "bprevious") end
end
local function lsp_do(fn) return function() if has_lsp() then fn() else need_lsp() end end end
local function git_do(fn, ...)
  local args = { ... }
  return function()
    local ok, gs = pcall(require, "gitsigns")
    if ok and gs[fn] and vim.b.gitsigns_status_dict then gs[fn](unpack(args)) else vim.notify("Git changes show for files in a local git repository.") end
  end
end
local function definition()
  if has_lsp() then return vim.lsp.buf.definition() end
  pcall(vim.cmd, "normal! gd")
end
local function references() if has_lsp() then (has_snacks and Snacks.picker.lsp_references or vim.lsp.buf.references)() else need_lsp() end end
actions.new = function() local w = main_win(); if w then api.nvim_set_current_win(w) end; vim.cmd("enew") end
actions.find = H.find

-- ---------------- Commands menu (Ctrl+Alt+P, the header's Commands button): everything the old Space menus had.
local menu = {
  { "Go to file", "Ctrl+P", function() HvAction("files") end },
  { "Search in files", "Ctrl+Alt+F", function() HvAction("grep") end },
  { "Find in this file", "Ctrl+F", H.find },
  { "Replace in this file", "Ctrl+H", H.replace },
  { "Go to line", "Ctrl+G", H.goto_line },
  { "Toggle file tree", "Ctrl+B", function() HvAction("tree") end },
  { "Recent files", "", function() HvAction("recent") end },
  { "Open files", "", function() HvAction("buffers") end },
  { "New file", "Ctrl+N", function() HvAction("new") end },
  { "Save", "Ctrl+S", H.save },
  { "Save as…", "", H.save_as },
  { "Close file", "Ctrl+F4", close_buf },
  { "Close other files", "", function() if has_snacks then Snacks.bufdelete.other() end end },
  { "Toggle terminal", "header", function() HvAction("term") end },
  { "Source control", "", function() HvAction("git") end },
  { "Git: changed files", "", function() if has_snacks and is_local then Snacks.picker.git_status() end end },
  { "Git: log", "", function() if has_snacks and is_local then Snacks.picker.git_log() end end },
  { "Git: next change", "", git_do("nav_hunk", "next") },
  { "Git: previous change", "", git_do("nav_hunk", "prev") },
  { "Git: preview change", "", git_do("preview_hunk") },
  { "Git: revert change", "", git_do("reset_hunk") },
  { "Git: stage change", "", git_do("stage_hunk") },
  { "Git: toggle line blame", "", git_do("toggle_current_line_blame") },
  { "Git: diff this file", "", git_do("diffthis") },
  { "Go to definition", "F12", definition },
  { "Find references", "Shift+F12", references },
  { "Rename symbol", "Ctrl+Alt+R", lsp_do(vim.lsp.buf.rename) },
  { "Code actions", "Ctrl+.", lsp_do(vim.lsp.buf.code_action) },
  { "Format file", "Shift+Alt+F", lsp_do(function() vim.lsp.buf.format() end) },
  { "Symbols in this file", "", function() HvAction("symbols") end },
  { "Problems on this line", "", vim.diagnostic.open_float },
  { "Toggle comment", "Ctrl+/", H.comment },
  { "Toggle word wrap", "Alt+Z", function() vim.wo.wrap = not vim.wo.wrap end },
  { "Language servers on/off (restart)", "", function() vim.cmd("HvLsp") end },
  { "Path bar (header)", "", function() HvAction("bar") end },
  { "All Neovim commands", "", function() if has_snacks then Snacks.picker.commands({ layout = { preset = "vscode" } }) else vim.api.nvim_feedkeys(":", "n", false) end end },
  { "Quit editor", "", function() vim.cmd("confirm qa") end },
}
function H.menu()
  local label = function(m) return m[1] .. string.rep(" ", math.max(2, 36 - vim.fn.strdisplaywidth(m[1]))) .. m[2] end
  if not has_snacks then
    return vim.ui.select(menu, { prompt = "Commands", format_item = label }, function(m) if m then m[3]() end end)
  end
  local items = {}
  for i, m in ipairs(menu) do items[i] = { text = label(m), idx = i } end
  Snacks.picker.pick({ title = "Commands", items = items, format = "text", preview = "none", layout = { preset = "vscode" },
    confirm = function(picker, item)
      picker:close()
      if item then vim.schedule(menu[item.idx][3]) end
    end })
end
actions.commands = H.menu

-- ---------------- keys (VS Code). Herdr keeps some for itself (keys.json "global" / "layout:hyper-view" / "terminal"):
-- Ctrl+Shift+P/F/Z/B/E/O/W/X/T/N/K/L, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp/Down, Ctrl+1..9, Alt+arrows, Alt+H/J/K/L,
-- Alt+Shift+H/J/K/L, F1, F2, F6, Ctrl+`; it sends Ctrl+Backspace as Ctrl+W (so Ctrl+W deletes a word, Ctrl+F4 /
-- Ctrl+Alt+W close the file) and Ctrl+Left/Right as Alt+B/F. The alternatives below reach the editor:
-- Ctrl+Alt+P commands, Ctrl+Alt+F search, Ctrl+Y redo, Ctrl+Alt+Left/Right tabs, Ctrl+Alt+Up/Down move line, Ctrl+Alt+R rename.
local map = vim.keymap.set
local ALL = { "n", "i", "s", "x" }
local function act(n) return function() HvAction(n) end end
map(ALL, "<C-s>", H.save, { desc = "Save" })
map(ALL, "<C-p>", act("files"), { desc = "Go to file" })
for _, k in ipairs({ "<C-S-p>", "<C-A-p>", "<F1>" }) do map(ALL, k, act("commands"), { desc = "Commands" }) end
for _, k in ipairs({ "<C-S-f>", "<C-A-f>" }) do map(ALL, k, act("grep"), { desc = "Search in files" }) end
map(ALL, "<C-b>", act("tree"), { desc = "Toggle file tree" })
map({ "n", "i", "s", "x", "t" }, "<C-`>", act("term"), { desc = "Toggle terminal" })
map({ "n", "i", "s", "x", "t" }, "<C-@>", act("term"), { desc = "Toggle terminal" })
map(ALL, "<C-n>", act("new"), { desc = "New file" })
for _, k in ipairs({ "<C-F4>", "<C-A-w>" }) do map(ALL, k, close_buf, { desc = "Close file" }) end
for _, k in ipairs({ "<C-Tab>", "<C-PageDown>", "<C-A-Right>" }) do map(ALL, k, function() cycle(1) end, { desc = "Next file" }) end
for _, k in ipairs({ "<C-S-Tab>", "<C-PageUp>", "<C-A-Left>" }) do map(ALL, k, function() cycle(-1) end, { desc = "Previous file" }) end
map(ALL, "<C-f>", H.find, { desc = "Find in file" })
map(ALL, "<C-h>", H.replace, { desc = "Replace in file" })
map({ "n", "i" }, "<C-g>", H.goto_line, { desc = "Go to line" })
map(ALL, "<F3>", function() H.find_next(1) end, { desc = "Next match" })
map(ALL, "<S-F3>", function() H.find_next(-1) end, { desc = "Previous match" })
-- Undo / redo
map({ "n", "i" }, "<C-z>", "<Cmd>silent undo<CR>", { desc = "Undo" })
map({ "s", "x" }, "<C-z>", "<Esc><Cmd>silent undo<CR>", { desc = "Undo" })
map("i", "<C-y>", function() return vim.fn.pumvisible() == 1 and "<C-y>" or "<Cmd>silent redo<CR>" end, { expr = true, desc = "Redo" })
map("n", "<C-y>", "<Cmd>silent redo<CR>", { desc = "Redo" })
map({ "s", "x" }, "<C-y>", "<Esc><Cmd>silent redo<CR>", { desc = "Redo" })
map({ "n", "i" }, "<C-S-z>", "<Cmd>silent redo<CR>", { desc = "Redo" })
map({ "s", "x" }, "<C-S-z>", "<Esc><Cmd>silent redo<CR>", { desc = "Redo" })
-- Clipboard (no selection: the whole line, like VS Code)
map(ALL, "<C-c>", H.copy, { desc = "Copy" })
map({ "n", "i" }, "<C-x>", H.cut_line, { desc = "Cut line" })
map({ "s", "x" }, "<C-x>", del_sel("<Cmd>lua HvEdit.copy()<CR>"), { expr = true, desc = "Cut" })
map("i", "<C-v>", "<C-g>u<C-r><C-o>+", { desc = "Paste" })
map({ "s", "x" }, "<C-v>", del_sel(nil, "<C-r><C-o>+"), { expr = true, desc = "Paste" })
map({ "s", "x" }, "<BS>", del_sel(), { expr = true, desc = "Delete selection" })
map({ "s", "x" }, "<Del>", del_sel(), { expr = true, desc = "Delete selection" })
-- Selection
map(ALL, "<C-a>", H.select_all, { desc = "Select all" })
map({ "i", "s", "x" }, "<C-d>", H.select_word, { desc = "Select word / next occurrence" })
for _, k in ipairs({ "<C-/>", "<C-_>" }) do map(ALL, k, H.comment, { desc = "Toggle comment" }) end
map("i", "<Tab>", function()
  if vim.fn.pumvisible() == 1 then return vim.fn.complete_info({ "selected" }).selected == -1 and "<C-n><C-y>" or "<C-y>" end
  return "<Tab>"
end, { expr = true, desc = "Indent / accept suggestion" })
map("i", "<S-Tab>", function() return vim.fn.pumvisible() == 1 and "<C-p>" or "<C-d>" end, { expr = true, desc = "Outdent" })
map("s", "<Tab>", "<C-g>>gv<C-g>", { desc = "Indent" })
map("s", "<S-Tab>", "<C-g><gv<C-g>", { desc = "Outdent" })
map("x", "<Tab>", ">gv", { desc = "Indent" })
map("x", "<S-Tab>", "<gv", { desc = "Outdent" })
-- Lines: move with Alt+Up/Down (Herdr usually keeps these) or Ctrl+Alt+Up/Down; copy with Alt+Shift+Up/Down.
for _, k in ipairs({ "<A-Up>", "<C-A-Up>", "<A-K>" }) do
  map({ "n", "i" }, k, function() H.move(-1) end, { desc = "Move line up" })
  map("s", k, "<C-g>:<C-u>silent! '<,'>move '<-2<CR>gv<C-g>", { desc = "Move lines up" })
  map("x", k, ":<C-u>silent! '<,'>move '<-2<CR>gv", { desc = "Move lines up" })
end
for _, k in ipairs({ "<A-Down>", "<C-A-Down>", "<A-J>" }) do
  map({ "n", "i" }, k, function() H.move(1) end, { desc = "Move line down" })
  map("s", k, "<C-g>:<C-u>silent! '<,'>move '>+1<CR>gv<C-g>", { desc = "Move lines down" })
  map("x", k, ":<C-u>silent! '<,'>move '>+1<CR>gv", { desc = "Move lines down" })
end
map({ "n", "i" }, "<A-S-Up>", function() H.dup(-1) end, { desc = "Copy line up" })
map({ "n", "i" }, "<A-S-Down>", function() H.dup(1) end, { desc = "Copy line down" })
-- Words and line start (Herdr sends Ctrl+Left/Right as Alt+B/F and Ctrl+Backspace as Ctrl+W)
map("i", "<M-b>", "<C-Left>", { desc = "Word left" })
map("i", "<M-f>", "<C-Right>", { desc = "Word right" })
-- In a selection an unshifted Ctrl+Left/Right ends it ('keymodel' stopsel) and moves a word, back in typing mode.
map("s", "<M-b>", "<C-Left>", { desc = "Word left" })
map("s", "<M-f>", "<C-Right>", { desc = "Word right" })
map("i", "<C-BS>", "<C-g>u<C-w>", { desc = "Delete word left" })
map("i", "<C-Del>", H.del_word_right, { desc = "Delete word right" })
map("i", "<Home>", H.home, { desc = "Line start (smart)" })
map(ALL, "<M-z>", function() vim.wo.wrap = not vim.wo.wrap end, { desc = "Toggle word wrap" })
-- Esc never leaves typing: it closes popups and clears the search highlight.
map("i", "<Esc>", function()
  if not is_text() then return "<Esc>" end
  if vim.fn.pumvisible() == 1 then return "<C-e>" end
  return "<Cmd>nohlsearch<CR><Cmd>lua HvEdit.esc()<CR>"
end, { expr = true, desc = "Close popups" })
map("n", "<Esc>", "<Cmd>nohlsearch<CR><Cmd>lua HvEdit.sync()<CR>")
-- Code (LSP when on): F12 definition, Shift+F12 references, F2 / Ctrl+Alt+R rename, Ctrl+. actions, Shift+Alt+F format.
map(ALL, "<F12>", definition, { desc = "Go to definition" })
map(ALL, "<S-F12>", references, { desc = "References" })
for _, k in ipairs({ "<F2>", "<C-A-r>" }) do map(ALL, k, lsp_do(vim.lsp.buf.rename), { desc = "Rename symbol" }) end
map(ALL, "<C-.>", lsp_do(vim.lsp.buf.code_action), { desc = "Code actions" })
map(ALL, "<M-F>", lsp_do(function() vim.lsp.buf.format() end), { desc = "Format file" })
-- Normal mode (only seen briefly, e.g. on the start screen): Space p still opens the commands.
map("n", "<leader>p", act("commands"), { desc = "Commands" })

-- ------------------------------------------------------------ start
vim.api.nvim_create_autocmd("VimEnter", { once = true, callback = function()
  -- First start: lazy.nvim showed its install window; close it and continue.
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    local b = vim.api.nvim_win_get_buf(w)
    if vim.bo[b].filetype == "lazy" then pcall(vim.api.nvim_win_close, w, true) end
  end
  vim.schedule(function()
    if vim.fn.argc() == 0 then
      if is_local then
        if has_snacks then
          local buf = vim.api.nvim_get_current_buf()
          if vim.bo[buf].filetype ~= "snacks_dashboard" and vim.api.nvim_buf_get_name(buf) == "" and vim.bo[buf].buftype == "" then
            pcall(Snacks.dashboard, { buf = buf, win = vim.api.nvim_get_current_win() })
          end
          Snacks.explorer()
          vim.defer_fn(function() local w = main_win(); if w then vim.api.nvim_set_current_win(w) end end, 80)
        end
      else
        HvOpen(g.hv_start or "~")
      end
    end
    g.hv_ready = true
    write_state()
  end)
end })
