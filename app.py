"""Fast Git GUI: Python-Backend + natives Webview (WebView2)."""
import functools
import json
import os
import subprocess
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

import webview

import gitops

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "fastgitgui")
CONFIG = os.path.join(DATA_DIR, "config.json")
ERRLOG = os.path.join(DATA_DIR, "error.log")
os.makedirs(DATA_DIR, exist_ok=True)

SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "target"}


def log_error(msg):
    try:
        with open(ERRLOG, "a", encoding="utf-8") as fh:
            fh.write(msg + "\n")
    except OSError:
        pass


def api(fn):
    """Fehler werden zu {ok: False, error} statt zu einer Exception im Webview."""
    @functools.wraps(fn)
    def wrapper(self, *a, **kw):
        try:
            return {"ok": True, "data": fn(self, *a, **kw)}
        except gitops.GitError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:  # noqa: BLE001
            log_error(traceback.format_exc())
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return wrapper


class Api:
    def __init__(self):
        self._lock = threading.Lock()
        self._window = None
        self._cfg = {"projects": []}
        try:
            with open(CONFIG, encoding="utf-8") as fh:
                self._cfg.update(json.load(fh))
        except (OSError, ValueError):
            pass

    # --- Konfiguration ----------------------------------------------------
    def _save(self):
        with self._lock:
            tmp = CONFIG + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._cfg, fh, indent=2, ensure_ascii=False)
            os.replace(tmp, CONFIG)

    def _norm(self, p):
        return os.path.normcase(os.path.normpath(p))

    def _repo(self, path):
        for p in self._cfg["projects"]:
            if self._norm(p) == self._norm(path):
                return p
        raise gitops.GitError("Projekt ist nicht registriert.")

    def _add(self, path):
        top = gitops.toplevel(path)
        if not top:
            return None
        if any(self._norm(p) == self._norm(top) for p in self._cfg["projects"]):
            return top
        self._cfg["projects"].append(top)
        return top

    # --- Projekte -----------------------------------------------------------
    @api
    def get_projects(self):
        return [{"path": p, "name": os.path.basename(p) or p} for p in self._cfg["projects"]]

    @api
    def add_project(self):
        sel = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        if not sel:
            return {"added": [], "rejected": []}
        top = self._add(sel[0])
        if not top:
            return {"added": [], "rejected": [sel[0]]}
        self._save()
        return {"added": [top], "rejected": []}

    @api
    def scan_folder(self):
        sel = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        if not sel:
            return {"added": [], "rejected": []}
        found = []

        def walk(d, depth):
            try:
                names = sorted(os.listdir(d))
            except OSError:
                return
            if ".git" in names:
                found.append(d)
                return
            if depth >= 3:
                return
            for n in names:
                if n in SKIP_DIRS or n.startswith("."):
                    continue
                sub = os.path.join(d, n)
                if os.path.isdir(sub):
                    walk(sub, depth + 1)

        walk(sel[0], 0)
        added = [t for t in (self._add(d) for d in found) if t]
        self._save()
        return {"added": added, "rejected": []}

    @api
    def remove_project(self, path):
        self._cfg["projects"] = [p for p in self._cfg["projects"] if self._norm(p) != self._norm(path)]
        self._save()
        return True

    @api
    def project_status(self, path):
        st = gitops.status(self._repo(path), numstat=False)
        st.pop("files")
        return st

    @api
    def fetch_one(self, path):
        repo = self._repo(path)
        rem = gitops.remotes(repo)
        if not rem:
            return {"note": "Kein Remote"}
        rc, _, err = gitops.run(repo, ["fetch", "--quiet", "--all"], check=False, timeout=60, network=True)
        return {"note": None if rc == 0 else (err.splitlines()[-1] if err else "Fetch fehlgeschlagen")}

    @api
    def fetch_all(self):
        def one(p):
            try:
                return gitops.run(p, ["fetch", "--quiet", "--all"], check=False, timeout=60, network=True)[0]
            except gitops.GitError:
                return 1
        with ThreadPoolExecutor(6) as ex:
            rcs = list(ex.map(one, list(self._cfg["projects"])))
        return {"failed": sum(1 for r in rcs if r != 0)}

    # --- Repo-Ansichten -----------------------------------------------------
    @api
    def worktree(self, path):
        return gitops.status(self._repo(path))

    @api
    def history(self, path, limit=400, all_refs=True):
        return gitops.log(self._repo(path), limit, all_refs)

    @api
    def commit_info(self, path, sha):
        return gitops.commit_info(self._repo(path), sha)

    @api
    def diff(self, path, sha, file, ignore_ws=False, full=False):
        return gitops.file_diff(self._repo(path), sha, file, ignore_ws, full)

    @api
    def branches(self, path):
        return gitops.branches(self._repo(path))

    @api
    def switch_branch(self, path, name):
        gitops.switch(self._repo(path), name)
        return True

    # --- Aktionen -----------------------------------------------------------
    @api
    def stage(self, path, paths):
        gitops.stage(self._repo(path), paths)
        return True

    @api
    def unstage(self, path, paths):
        gitops.unstage(self._repo(path), paths)
        return True

    @api
    def precommit_check(self, path):
        return gitops.behind_info(self._repo(path))

    @api
    def commit(self, path, message):
        return gitops.commit(self._repo(path), message)

    @api
    def open_folder(self, path):
        os.startfile(self._repo(path))
        return True

    @api
    def open_vscode(self, path):
        repo = self._repo(path)
        subprocess.Popen(["cmd", "/c", "code", repo], creationflags=gitops.CREATE_NO_WINDOW,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True


def main():
    a = Api()
    sys.excepthook = lambda t, v, tb: log_error("".join(traceback.format_exception(t, v, tb)))
    win = webview.create_window(
        "Fast Git GUI",
        url=os.path.join(ROOT, "web", "index.html"),
        js_api=a,
        width=1560, height=920, min_size=(980, 560),
        background_color="#1c1e22",
    )
    a._window = win
    webview.start(private_mode=False, storage_path=os.path.join(DATA_DIR, "webview"))


if __name__ == "__main__":
    main()
