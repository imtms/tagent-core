#!/usr/bin/env python3
"""Race-resistant workspace operations using directory-fd-relative syscalls.

Every path component is opened relative to an already validated directory descriptor with
O_NOFOLLOW. No operation re-resolves an attacker-controlled absolute pathname.
"""
import errno
import json
import os
import stat
import sys
import time
import uuid

O_PATH = getattr(os, "O_PATH", os.O_RDONLY)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


def fail(message: str, code: str = "WORKSPACE_PATH_REJECTED") -> None:
    print(json.dumps({"ok": False, "code": code, "error": message}), file=sys.stderr)
    raise SystemExit(2)


def components(target: str) -> list[str]:
    if "\0" in target or os.path.isabs(target):
        fail("Absolute or NUL-containing paths are not allowed")
    normalized = os.path.normpath(target or ".")
    if normalized == ".." or normalized.startswith("../"):
        fail("Path escapes the workspace")
    return [] if normalized == "." else normalized.split("/")


def open_root(root: str) -> int:
    canonical = os.path.realpath(root)
    fd = os.open(canonical, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        fail("Workspace root is not a directory")
    return fd


def descend(root_fd: int, parts: list[str], create: bool = False) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            if part in ("", ".", ".."):
                fail("Invalid workspace path component")
            try:
                child = os.open(part, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o700, dir_fd=current)
                child = os.open(part, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, dir_fd=current)
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    fail("Symbolic links are not allowed in workspace paths")
                raise
            if not stat.S_ISDIR(os.fstat(child).st_mode):
                os.close(child)
                fail("A workspace path component is not a directory")
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def test_pause(stage: str) -> None:
    configured = os.environ.get("TAGENT_FD_HELPER_STAGE", "")
    if configured and configured != stage:
        return
    ready = os.environ.get("TAGENT_FD_HELPER_READY")
    release = os.environ.get("TAGENT_FD_HELPER_RELEASE")
    if not ready or not release:
        return
    with open(ready, "w", encoding="utf-8") as stream:
        stream.write("ready")
    deadline = time.time() + 10
    while not os.path.exists(release):
        if time.time() > deadline:
            fail("Test synchronization timed out", "WORKSPACE_IO_ERROR")
        time.sleep(0.005)


def read_file(root_fd: int, parts: list[str]) -> None:
    if not parts:
        fail("A file path is required")
    parent = descend(root_fd, parts[:-1])
    try:
        test_pause("before_open")
        try:
            fd = os.open(parts[-1], os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC, dir_fd=parent)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                fail("Symbolic links are not allowed in workspace paths")
            raise
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode):
                fail("Workspace path is not a regular file")
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def list_directory(root_fd: int, parts: list[str]) -> None:
    directory = descend(root_fd, parts)
    try:
        test_pause("after_directory_open")
        entries = []
        for name in os.listdir(directory):
            metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
            entries.append({"name": name, "directory": stat.S_ISDIR(metadata.st_mode), "symlink": stat.S_ISLNK(metadata.st_mode)})
        sys.stdout.write(json.dumps(entries))
    finally:
        os.close(directory)


def write_file(root_fd: int, parts: list[str]) -> None:
    if not parts:
        fail("A file path is required")
    parent = descend(root_fd, parts[:-1], create=True)
    temporary = f".tagent-write-{uuid.uuid4().hex}.tmp"
    created = False
    try:
        test_pause("after_parent_open")
        try:
            metadata = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode):
                fail("Symbolic-link file targets are not allowed")
            if not stat.S_ISREG(metadata.st_mode):
                fail("Workspace file target is not a regular file")
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600, dir_fd=parent)
        created = True
        try:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        # renameat is relative to the pinned parent descriptor and replaces a symlink entry;
        # it never follows the destination.
        os.rename(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        os.fsync(parent)
        sys.stdout.write(json.dumps({"ok": True}))
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


def main() -> None:
    if len(sys.argv) != 4:
        fail("Usage: helper OP ROOT TARGET", "WORKSPACE_IO_ERROR")
    operation, root, target = sys.argv[1:]
    root_fd = open_root(root)
    try:
        parts = components(target)
        if operation == "read":
            read_file(root_fd, parts)
        elif operation == "list":
            list_directory(root_fd, parts)
        elif operation == "write":
            write_file(root_fd, parts)
        else:
            fail("Unknown operation", "WORKSPACE_IO_ERROR")
    except FileNotFoundError:
        fail("Workspace path does not exist", "ENOENT")
    except PermissionError:
        fail("Workspace path is not accessible", "EACCES")
    except OSError as error:
        fail(str(error), error.__class__.__name__)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    main()
