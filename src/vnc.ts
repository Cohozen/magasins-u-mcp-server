/**
 * noVNC access to the browser, opened only when a person has to act (login, Cloudflare check)
 * and closed as soon as that is done.
 *
 * x11vnc listens on loopback only; websockify serves noVNC on `VNC_PORT`, which must never be
 * exposed outside the local network. The password is drawn at every opening and handed over in a
 * file that x11vnc deletes after reading (`rm:`), so it never shows in `ps`. VNC caps passwords
 * at 8 characters: the protection comes from the short opening window and the local network,
 * not from its length.
 *
 * Without a virtual screen (development on macOS) there is nothing to open: the person acts
 * directly in the browser window.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export type Vnc = { url: string | null; stop: () => void };

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const password = (): string =>
    Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

const launch = (command: string, args: string[]): ChildProcess => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", (error) =>
        log.error("noVNC: cannot start", { command, error: String(error) }),
    );
    return child;
};

export const startVnc = (config: Config): Vnc => {
    const display = process.env.DISPLAY;
    if (display === undefined || process.platform === "darwin")
        return { url: null, stop: () => {} };

    const secret = password();
    const file = join(tmpdir(), `vnc-${process.pid}-${Date.now()}`);
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });

    const server = launch("x11vnc", [
        "-display",
        display,
        "-localhost",
        "-rfbport",
        "5900",
        "-passwdfile",
        `rm:${file}`,
        "-forever",
        "-shared",
        "-quiet",
    ]);
    const web = launch("websockify", [
        "--web",
        "/usr/share/novnc",
        String(config.vncPort),
        "localhost:5900",
    ]);

    return {
        url: `http://${config.vncHost}:${config.vncPort}/vnc.html?autoconnect=1&resize=scale&password=${secret}`,
        stop: () => {
            server.kill();
            web.kill();
        },
    };
};
