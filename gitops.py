"""Duenne Schicht ueber die git-CLI. Keine GUI-Abhaengigkeiten."""
import html
import os
import re
import subprocess
import threading

from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name, get_lexer_for_filename
from pygments.util import ClassNotFound

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_SLOTS = threading.BoundedSemaphore(8)  # nicht 40 git-Prozesse auf einmal starten

MAX_HIGHLIGHT_BYTES = 400_000
MAX_DIFF_LINES = 4000
MAX_UNTRACKED_READ = 1_000_000


class GitError(Exception):
    pass


def _env(network=False):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["LC_ALL"] = "C.UTF-8"
    if network:
        env["GCM_INTERACTIVE"] = "never"
        env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10")
    return env


def run(repo, args, stdin=None, timeout=30, check=True, network=False):
    """Fuehrt git aus und liefert (returncode, stdout-bytes, stderr-text)."""
    cmd = ["git", "-C", repo, "--no-optional-locks", "--literal-pathspecs",
           "-c", "core.quotepath=false", "-c", "color.ui=false", *args]
    with _SLOTS:
        try:
            p = subprocess.run(
                cmd, input=stdin, capture_output=True, timeout=timeout,
                creationflags=CREATE_NO_WINDOW, env=_env(network),
                stdin=None if stdin is not None else subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            raise GitError(f"Zeitueberschreitung bei: git {' '.join(args[:2])}")
        except FileNotFoundError:
            raise GitError("git wurde nicht gefunden (PATH).")
    err = p.stderr.decode("utf-8", "replace").strip()
    if check and p.returncode != 0:
        raise GitError(err or f"git {args[0]} fehlgeschlagen ({p.returncode})")
    return p.returncode, p.stdout, err


def text(repo, args, **kw):
    return run(repo, args, **kw)[1].decode("utf-8", "replace")


def toplevel(path):
    rc, out, _ = run(path, ["rev-parse", "--show-toplevel"], check=False)
    if rc != 0:
        return None
    return os.path.normpath(out.decode("utf-8", "replace").strip())


# --- Status -----------------------------------------------------------------

def _letter(x, y):
    if x == "?" or y == "?":
        return "?"
    if "U" in (x, y) or (x, y) in (("A", "A"), ("D", "D")):
        return "!"
    c = y if y != "." else x
    return c


def status(repo, numstat=True):
    out = run(repo, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])[1]
    parts = out.decode("utf-8", "replace").split("\0")
    info = {"branch": None, "oid": None, "upstream": None, "ahead": None, "behind": None}
    files = []
    i = 0
    while i < len(parts):
        p = parts[i]
        i += 1
        if not p:
            continue
        if p.startswith("# "):
            k, _, v = p[2:].partition(" ")
            if k == "branch.head":
                info["branch"] = v
            elif k == "branch.oid":
                info["oid"] = None if v == "(initial)" else v
            elif k == "branch.upstream":
                info["upstream"] = v
            elif k == "branch.ab":
                m = re.match(r"\+(\d+) -(\d+)", v)
                if m:
                    info["ahead"], info["behind"] = int(m.group(1)), int(m.group(2))
            continue
        t = p[0]
        orig = None
        if t == "1":
            f = p.split(" ", 8)
            xy, path = f[1], f[8]
        elif t == "2":
            f = p.split(" ", 9)
            xy, path = f[1], f[9]
            orig = parts[i]
            i += 1
        elif t == "u":
            f = p.split(" ", 10)
            xy, path = f[1], f[10]
        elif t == "?":
            xy, path = "??", p[2:]
        else:
            continue
        x, y = xy[0], xy[1]
        if x == "?":
            staged = "none"
        elif x == ".":
            staged = "none"
        elif y == ".":
            staged = "full"
        else:
            staged = "partial"
        files.append({"path": path, "orig": orig, "st": _letter(x, y),
                      "staged": staged, "untracked": x == "?"})
    files.sort(key=lambda f: f["path"].lower())
    info["count"] = len(files)
    info["files"] = files
    if numstat and files:
        _add_numstat(repo, files)
    return info


def _head_or_empty(repo):
    rc, out, _ = run(repo, ["rev-parse", "--verify", "-q", "HEAD"], check=False)
    if rc == 0:
        return "HEAD"
    return empty_tree(repo)


_empty = {}


def empty_tree(repo):
    if "t" not in _empty:
        _empty["t"] = run(repo, ["hash-object", "-t", "tree", "--stdin"], stdin=b"")[1].decode().strip()
    return _empty["t"]


def _parse_numstat(raw):
    """-z numstat -> {pfad: (add, del, binaer)}"""
    res = {}
    toks = raw.decode("utf-8", "replace").split("\0")
    i = 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if not t:
            continue
        a, d, rest = t.split("\t", 2)
        if rest == "":  # Umbenennung: es folgen alter und neuer Pfad
            path = toks[i + 1]
            i += 2
        else:
            path = rest
        if a == "-":
            res[path] = (None, None, True)
        else:
            res[path] = (int(a), int(d), False)
    return res


def _count_lines(repo, path):
    full = os.path.join(repo, path)
    try:
        if os.path.getsize(full) > MAX_UNTRACKED_READ:
            return None, None, False
        with open(full, "rb") as fh:
            data = fh.read()
    except OSError:
        return None, None, False
    if b"\0" in data[:8000]:
        return None, None, True
    n = data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)
    return n, 0, False


def _add_numstat(repo, files):
    base = _head_or_empty(repo)
    rc, raw, _ = run(repo, ["diff", "--numstat", "-z", "-M", base], check=False)
    ns = _parse_numstat(raw) if rc == 0 else {}
    for f in files:
        if f["untracked"]:
            a, d, b = _count_lines(repo, f["path"])
        else:
            a, d, b = ns.get(f["path"], (None, None, False))
        f["add"], f["del"], f["bin"] = a, d, b


# --- Historie -----------------------------------------------------------------

def remotes(repo):
    return set(text(repo, ["remote"], check=False).split())


def _parse_refs(deco, remote_names):
    refs = []
    if not deco:
        return refs
    for r in deco.split(", "):
        r = r.strip()
        if r.startswith("HEAD -> "):
            refs.append({"t": "head", "n": r[8:]})
        elif r == "HEAD":
            refs.append({"t": "head", "n": "HEAD"})
        elif r.startswith("tag: "):
            refs.append({"t": "tag", "n": r[5:]})
        elif "/" in r and r.split("/", 1)[0] in remote_names:
            if r.endswith("/HEAD"):
                continue
            refs.append({"t": "remote", "n": r})
        else:
            refs.append({"t": "branch", "n": r})
    return refs


def log(repo, limit=400, all_refs=True):
    rem = remotes(repo)
    args = ["log", "--topo-order", "-n", str(limit), "--decorate=short",
            "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e"]
    if all_refs:
        args += ["--branches", "--remotes", "--tags", "HEAD"]
    rc, out, _ = run(repo, args, check=False)
    if rc != 0:  # leeres Repo
        return {"rows": [], "cols": 1}
    rows = []
    lanes = []
    maxcols = 1
    for rec in out.decode("utf-8", "replace").split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        sha, parents, an, at, deco, subj = rec.split("\x1f", 5)
        parents = parents.split() if parents else []

        mine = [i for i, l in enumerate(lanes) if l == sha]
        if mine:
            col = mine[0]
        else:
            col = next((i for i, l in enumerate(lanes) if l is None), None)
            if col is None:
                lanes.append(None)
                col = len(lanes) - 1
            lanes[col] = sha
        before = list(lanes)

        for i in mine[1:]:
            lanes[i] = None
        edges = []
        if parents:
            lanes[col] = parents[0]
            edges.append([col, col, "out"])
            for p in parents[1:]:
                if p in lanes:
                    j = lanes.index(p)
                else:
                    j = next((i for i, l in enumerate(lanes) if l is None), None)
                    if j is None:
                        lanes.append(p)
                        j = len(lanes) - 1
                    else:
                        lanes[j] = p
                edges.append([col, j, "out"])
        else:
            lanes[col] = None

        merged = set(mine)
        for i, l in enumerate(before):
            if l is None:
                continue
            if i in merged:
                edges.append([i, col, "in"])
            elif i != col and i < len(lanes) and lanes[i] == l:
                edges.append([i, i, "through"])
        maxcols = max(maxcols, len(before), len(lanes))
        rows.append({"sha": sha, "short": sha[:7], "parents": parents,
                     "col": col, "edges": edges, "author": an,
                     "time": int(at or 0), "subject": subj,
                     "refs": _parse_refs(deco, rem)})
        while lanes and lanes[-1] is None:
            lanes.pop()
    return {"rows": rows, "cols": maxcols}


def commit_info(repo, sha):
    fmt = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B"
    raw = text(repo, ["show", "-s", f"--format={fmt}", sha])
    h, an, ae, at, par, body = raw.split("\x1f", 5)
    parents = par.split()
    base = parents[0] if parents else empty_tree(repo)
    rc, rawns, _ = run(repo, ["diff", "--numstat", "-z", "-M", base, sha], check=False)
    ns = _parse_numstat(rawns) if rc == 0 else {}
    rc, rawst, _ = run(repo, ["diff", "--name-status", "-z", "-M", base, sha], check=False)
    toks = rawst.decode("utf-8", "replace").split("\0") if rc == 0 else []
    files = []
    i = 0
    while i < len(toks):
        s = toks[i]
        i += 1
        if not s:
            continue
        code = s[0]
        if code in "RC":
            orig, path = toks[i], toks[i + 1]
            i += 2
        else:
            orig, path = None, toks[i]
            i += 1
        a, d, b = ns.get(path, (None, None, False))
        files.append({"path": path, "orig": orig, "st": code, "add": a, "del": d,
                      "bin": b, "staged": "none", "untracked": False})
    files.sort(key=lambda f: f["path"].lower())
    return {"sha": h, "author": an, "email": ae, "time": int(at or 0),
            "parents": parents, "body": body.strip(), "files": files}


# --- Branches -----------------------------------------------------------------

def branches(repo):
    fmt = "%(refname)%09%(refname:short)%09%(HEAD)"
    raw = text(repo, ["for-each-ref", "--sort=-committerdate", f"--format={fmt}",
                      "refs/heads", "refs/remotes"])
    local, remote_only = [], []
    cur = None
    names = set()
    rows = []
    for line in raw.splitlines():
        ref, short, head = line.split("\t")
        rows.append((ref, short, head))
        if ref.startswith("refs/heads/"):
            names.add(short)
    for ref, short, head in rows:
        if ref.startswith("refs/heads/"):
            local.append(short)
            if head == "*":
                cur = short
        else:
            if short.endswith("/HEAD") or "/" not in short:
                continue
            if short.split("/", 1)[1] not in names:
                remote_only.append(short)
    return {"current": cur, "local": local, "remote": remote_only}


def switch(repo, name):
    b = branches(repo)
    if name in b["local"]:
        run(repo, ["switch", name])
    elif name in b["remote"]:
        run(repo, ["switch", "--track", name])
    else:
        raise GitError(f"Unbekannter Branch: {name}")


# --- Stage / Commit ---------------------------------------------------------------

def _pathspec(paths):
    return ("\0".join(paths) + "\0").encode("utf-8")


def stage(repo, paths):
    if paths is None:
        run(repo, ["add", "-A"])
    elif paths:
        run(repo, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], stdin=_pathspec(paths))


def unstage(repo, paths):
    has_head = run(repo, ["rev-parse", "--verify", "-q", "HEAD"], check=False)[0] == 0
    if paths is None:
        run(repo, ["reset", "-q"] if has_head else ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "."])
    elif paths:
        if has_head:
            run(repo, ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], stdin=_pathspec(paths))
        else:
            run(repo, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-",
                       "--pathspec-file-nul"], stdin=_pathspec(paths))


def behind_info(repo):
    """Fetch auf den Remote des aktuellen Branches (sonst origin), danach ahead/behind."""
    st = text(repo, ["status", "--porcelain=v2", "--branch"], check=False)
    upstream = None
    branch = None
    for line in st.splitlines():
        if line.startswith("# branch.upstream "):
            upstream = line.split(" ", 2)[2]
        elif line.startswith("# branch.head "):
            branch = line.split(" ", 2)[2]
    rem = remotes(repo)
    if not rem:
        return {"fetched": False, "note": "Kein Remote konfiguriert", "behind": 0, "ahead": 0}
    remote = upstream.split("/", 1)[0] if upstream else ("origin" if "origin" in rem else sorted(rem)[0])
    rc, _, err = run(repo, ["fetch", "--quiet", remote], check=False, timeout=40, network=True)
    if rc != 0:
        return {"fetched": False, "note": f"Fetch fehlgeschlagen: {err.splitlines()[-1] if err else 'unbekannt'}",
                "behind": 0, "ahead": 0}
    target = upstream
    if not target and branch and branch != "(detached)":
        cand = f"{remote}/{branch}"
        if run(repo, ["rev-parse", "--verify", "-q", cand], check=False)[0] == 0:
            target = cand
    if not target:
        return {"fetched": True, "note": None, "behind": 0, "ahead": 0, "remote": remote}
    rc, out, _ = run(repo, ["rev-list", "--left-right", "--count", f"HEAD...{target}"], check=False)
    ahead = behind = 0
    if rc == 0:
        a, b = out.decode().split()
        ahead, behind = int(a), int(b)
    return {"fetched": True, "note": None, "behind": behind, "ahead": ahead, "target": target}


def commit(repo, message):
    message = message.strip()
    if not message:
        raise GitError("Commit-Nachricht fehlt.")
    staged = run(repo, ["diff", "--cached", "--quiet"], check=False)[0] == 1
    if not staged:
        run(repo, ["add", "-A"])
        if run(repo, ["diff", "--cached", "--quiet"], check=False)[0] == 0:
            raise GitError("Keine Aenderungen zum Committen.")
    rc, out, err = run(repo, ["commit", "-F", "-"], stdin=message.encode("utf-8"), timeout=180)
    return out.decode("utf-8", "replace").strip()


# --- Diff + Syntax Highlighting ---------------------------------------------------

_FMT = HtmlFormatter(nowrap=True, classprefix="tok-")
_ALIAS = {".vue": "html", ".svelte": "html", ".jsonc": "json", ".mjs": "js", ".cjs": "js"}


def _lexer(path, code):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in _ALIAS:
            return get_lexer_by_name(_ALIAS[ext], stripnl=False, ensurenl=True)
        return get_lexer_for_filename(path, code, stripnl=False, ensurenl=True)
    except ClassNotFound:
        return None


def _norm_lines(code):
    lines = code.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _highlighted(path, code):
    """-> (klartext-Zeilen, html-Zeilen oder None)"""
    plain = _norm_lines(code)
    if len(code) > MAX_HIGHLIGHT_BYTES:
        return plain, None
    lx = _lexer(path, code)
    if lx is None:
        return plain, None
    out = highlight(code.replace("\r\n", "\n").replace("\r", "\n"), lx, _FMT).split("\n")
    if out and out[-1] == "":
        out.pop()
    if len(out) != len(plain):
        return plain, None
    return plain, out


def _blob(repo, rev, path):
    if rev is None:
        try:
            with open(os.path.join(repo, path), "rb") as fh:
                data = fh.read()
        except OSError:
            return ""
    else:
        rc, data, _ = run(repo, ["show", f"{rev}:{path}"], check=False)
        if rc != 0:
            return ""
    if b"\0" in data[:8000]:
        return ""
    return data.decode("utf-8", "replace")


_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)")


def file_diff(repo, sha, f, ignore_ws=False, full=False):
    """sha=None: Arbeitsverzeichnis gegen HEAD, sonst Commit gegen Elternteil.
    f: Eintrag aus der Dateiliste (path, orig, st, untracked)."""
    path, orig = f["path"], f.get("orig")
    res = {"path": path, "orig": orig, "hunks": [], "binary": False, "truncated": False,
           "empty": False}

    if sha is None:
        base = _head_or_empty(repo)
        new_rev = None
    else:
        parents = text(repo, ["show", "-s", "--format=%P", sha]).split()
        base = parents[0] if parents else empty_tree(repo)
        new_rev = sha

    # Untracked: kein git-Diff, alle Zeilen sind neu.
    if f.get("untracked"):
        code = _blob(repo, None, path)
        if not code and os.path.exists(os.path.join(repo, path)) and \
                os.path.getsize(os.path.join(repo, path)) > 0:
            res["binary"] = True
            return res
        plain, hl = _highlighted(path, code)
        lines = []
        for n, ln in enumerate(plain[:MAX_DIFF_LINES if not full else None], 1):
            lines.append(["+", None, n, hl[n - 1] if hl else html.escape(ln)])
        if len(plain) > len(lines):
            res["truncated"] = True
        if lines:
            res["hunks"].append({"header": f"@@ -0,0 +1,{len(plain)} @@", "lines": lines})
        else:
            res["empty"] = True
        return res

    args = ["diff", "-M", "-U3", "--no-color", "--no-ext-diff", "--no-textconv"]
    if ignore_ws:
        args.append("-w")
    args.append(base)
    if new_rev:
        args.append(new_rev)
    args.append("--")
    args += [orig, path] if orig else [path]
    raw = text(repo, args, check=False)
    if not raw.strip():
        res["empty"] = True
        return res
    if "\nBinary files" in raw or raw.startswith("Binary files") or "GIT binary patch" in raw:
        res["binary"] = True
        return res

    old_path = orig or path
    old_plain, old_hl = ([], None)
    new_plain, new_hl = ([], None)
    if base != empty_tree(repo) and f.get("st") != "A":
        old_plain, old_hl = _highlighted(old_path, _blob(repo, base, old_path))
    if f.get("st") != "D":
        new_plain, new_hl = _highlighted(path, _blob(repo, new_rev, path))

    def pick(side_plain, side_hl, no, txt):
        if side_hl is not None and 0 < no <= len(side_plain) and side_plain[no - 1] == txt:
            return side_hl[no - 1]
        return html.escape(txt)

    cur = None
    o = n = 0
    count = 0
    started = False
    for line in raw.split("\n"):
        m = _HUNK.match(line)
        if m:
            started = True
            o, n = int(m.group(1)), int(m.group(2))
            cur = {"header": line, "lines": []}
            res["hunks"].append(cur)
            continue
        if not started or cur is None:
            continue
        if not line:
            continue
        c, body = line[0], line[1:].rstrip("\r")
        if c == "\\":
            continue
        if count >= MAX_DIFF_LINES and not full:
            res["truncated"] = True
            break
        if c == "+":
            cur["lines"].append(["+", None, n, pick(new_plain, new_hl, n, body)])
            n += 1
        elif c == "-":
            cur["lines"].append(["-", o, None, pick(old_plain, old_hl, o, body)])
            o += 1
        else:
            cur["lines"].append([" ", o, n, pick(new_plain, new_hl, n, body)])
            o += 1
            n += 1
        count += 1
    return res


# --- Pull / Push ------------------------------------------------------------------

def _upstream(repo):
    rc, out, _ = run(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], check=False)
    return out.decode().strip() if rc == 0 else None


def _branch(repo):
    name = text(repo, ["branch", "--show-current"]).strip()
    if not name:
        raise GitError("Detached HEAD: kein Branch ausgewaehlt.")
    return name


def pull(repo):
    """Nur Fast-Forward. Bei divergierenden Staenden bricht git ab, kein Merge."""
    _branch(repo)
    if not _upstream(repo):
        raise GitError("Der Branch hat keinen Upstream.")
    rc, out, err = run(repo, ["pull", "--ff-only"], timeout=180, network=True)
    return (out.decode("utf-8", "replace").strip() or err).splitlines()[-1] if (out or err) else "Pull abgeschlossen"


def push(repo):
    branch = _branch(repo)
    if _upstream(repo):
        args = ["push"]
    else:
        rem = remotes(repo)
        if not rem:
            raise GitError("Kein Remote konfiguriert.")
        remote = "origin" if "origin" in rem else sorted(rem)[0]
        args = ["push", "-u", remote, branch]
    rc, out, err = run(repo, args, timeout=180, network=True)
    lines = [l for l in err.splitlines() if l.strip()]
    return lines[-1] if lines else "Push abgeschlossen"


# --- Verwerfen ----------------------------------------------------------------------

def _in_head(repo, path):
    return run(repo, ["cat-file", "-e", f"HEAD:{path}"], check=False)[0] == 0


def discard(repo, paths):
    """Verwirft Aenderungen (Index und Arbeitsverzeichnis) gegen HEAD.
    paths=None: alles. Dateien, die es in HEAD nicht gibt, werden geloescht."""
    entries = status(repo, numstat=False)["files"]
    if paths is not None:
        wanted = set(paths)
        entries = [e for e in entries if e["path"] in wanted]
    restore, remove = [], []
    for e in entries:
        for p in [e["orig"], e["path"]]:
            if not p:
                continue
            if not e["untracked"] and _in_head(repo, p):
                restore.append(p)
            elif p == e["path"]:
                remove.append(p)
    if remove:
        tracked = [p for p in remove if run(repo, ["ls-files", "--error-unmatch", "--", p], check=False)[0] == 0]
        if tracked:
            run(repo, ["rm", "-f", "-q", "--cached", "--pathspec-from-file=-", "--pathspec-file-nul"],
                stdin=_pathspec(tracked))
    if restore:
        run(repo, ["restore", "--source=HEAD", "--staged", "--worktree",
                   "--pathspec-from-file=-", "--pathspec-file-nul"], stdin=_pathspec(restore))
    root = os.path.realpath(repo)
    for p in remove:
        full = os.path.realpath(os.path.join(repo, p))
        if not full.startswith(root + os.sep):
            raise GitError(f"Pfad ausserhalb des Repos: {p}")
        try:
            os.remove(full)
        except FileNotFoundError:
            pass
    return {"restored": len(set(restore)), "deleted": len(remove)}
