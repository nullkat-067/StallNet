# Stall (StallNet)

A dependency-free Node.js CLI to browse, install, and test **public** GitHub repositories — built for Termux (Android) and any terminal with Node.js >= 18.

```
███████╗████████╗ █████╗ ██╗     ██╗
██╔════╝╚══██╔══╝██╔══██╗██║     ██║
███████╗   ██║   ███████║██║     ██║
╚════██║   ██║   ██╔══██║██║     ██║
███████║   ██║   ██║  ██║███████╗███████╗
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝
             Net
```

## Features

- **Browse** the public repositories of **nullkat-067** (fixed account, not configurable).
- **Install** — clone a repository into a folder of your choice (never overwrites existing folders).
- **Redirect** — open the repository page in your browser.
- **Test** — analyze the project, then:
  - probe the live deployment URL (homepage / GitHub Pages),
  - open an isolated online preview (StackBlitz),
  - run the build/tests inside a hardened Docker sandbox (non-root, 1 CPU, 768 MB, no capabilities).
- **Privacy-first** — private repositories are never fetched or displayed. The token is never stored or printed, and is only sent to the configured GitHub API host.
- **Zero npm dependencies** — only the Node.js standard library (`fetch`, `child_process`, `readline`, …).

## Requirements

- Node.js **>= 18** (uses global `fetch`).
- `git` — required only for the **Install** feature.
- Optional: `termux-open-url` (Termux) / `xdg-open` / `open` for the **Redirect** feature.
- Optional: a Docker client + reachable daemon for the **Test → Sandbox** method.

### Termux quick install

```bash
pkg update && pkg upgrade
pkg install nodejs git termux-tools
```

## Install

```bash
git clone https://github.com/nullkat-067/stallnet.git
cd stallnet
node index.js
```

Or, if you have `npm`:

```bash
npm install -g .
stall
```

## Usage

Just run it:

```bash
stall
# or
node index.js
```

The interactive menu walks you through:

1. **Connecting to GitHub** — fetches the profile of **nullkat-067**.
2. **Fetching repositories** — paginated, public-only list.
3. **Project list** — pick a repository by number.
4. **Repository menu** — `[1] Install`, `[2] Redirect`, `[3] Test`, `[0] Back`, `[q] Quit`.

### List navigation

| Key | Action |
| --- | --- |
| `1`..`n` | Open repository detail |
| `n` | Next page |
| `p` | Previous page |
| `r` | Refresh repository list |
| `/text` | Filter by name/description/language |
| `q` | Quit |

## Environment variables

All optional.

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` / `STALL_GITHUB_TOKEN` | *(empty)* | Raises the API rate limit. Any scope (or none) is enough. Never stored or printed. |
| `STALL_DIR` | current working directory | Destination folder for `Install` |
| `STALL_PAGE` | `5` | Repositories per menu page (minimum 3) |
| `STALL_TIMEOUT_MS` | `15000` | Network request timeout in milliseconds |
| `DOCKER_HOST` | *(local socket)* | Docker host for the `Test → Sandbox` method, e.g. `ssh://user@host` |
| `NO_COLOR` | *(unset)* | Disable ANSI colors |
| `STALL_API_URL` | `https://api.github.com` | Override API base URL (advanced) |
| `STALL_RAW_URL` | `https://raw.githubusercontent.com` | Override raw content base URL (advanced) |

> The account is **hardcoded to `nullkat-067`** — there is no setting or prompt to change it.

## How the "Test" feature works

When you select a repository, Stall analyzes it:

- Detects runtime from `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `composer.json`, `pom.xml`, `build.gradle`, or `index.html`.
- Classifies the project: `CLI`, `API/server`, `website`, `full-stack`, `static website`, or language-specific.
- Lists languages, entry point, dependencies, npm scripts.
- Flags database/service dependencies and `.env` files.
- For static sites, verifies that local assets referenced in `index.html` actually exist in the repository.

Then it offers up to three testing methods:

1. **Probe live URL** — issues an HTTP request to `homepage` or GitHub Pages URL, reports status/time/content-type/bytes/title.
2. **Isolated online preview** — opens `https://stackblitz.com/github/<owner>/<repo>` in the browser.
3. **Docker sandbox** — clones the repo and runs detected build/test commands inside a hardened container:
   - `--rm --cpus 1 --memory 768m --pids-limit 512`
   - `--cap-drop ALL --security-opt no-new-privileges`
   - `--user 1000:1000`
   - `--tmpfs /work` and `--tmpfs /tmp` (no host folder mounted)
   - Internet access is allowed (for `git clone` and dependency install).

The Docker sandbox **does not run code on the local device** — the Docker client only sends instructions to the daemon (local or remote via `DOCKER_HOST`).

> ⚠️ Only test repositories you trust. Even sandboxed code can consume resources on the Docker host.

## Security notes

- **Private repositories are never shown.** Even if the API returns them, they are filtered out.
- **The token is never persisted** (except as an environment variable you set yourself) and is **redacted** in error messages.
- **The token is only sent to the configured API host** (`STALL_API_URL`), never to `raw.githubusercontent.com` or third-party hosts.
- **User input is validated** before being used as a folder name or path component.
- **The temporary clone folder is cleaned up** if `git clone` fails or is cancelled.
- **Ctrl+C** cancels the active operation; press three times rapidly to force-quit.

## Configuration file

Stall does **not** store any configuration file. The account is fixed and nothing is written to disk.

## Project structure

```
stallnet/
├── index.js       # entire CLI
└── package.json   # metadata + bin entry
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot reach api.github.com` | Check internet / DNS. |
| `GitHub API rate limit reached` | Set `GITHUB_TOKEN`. |
| `git not found` | `pkg install git` (Termux) / install git. |
| `Docker daemon not responding` | Start the local daemon, or set `DOCKER_HOST`. |
| Garbled characters | Use a font with box-drawing/emoji support; try `NO_COLOR=1`. |

## License

MIT © NullKat
