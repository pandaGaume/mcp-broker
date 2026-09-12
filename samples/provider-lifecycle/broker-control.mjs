/**
 * Start and stop a broker process on demand, so the lifecycle scenario can kill
 * one deliberately and bring it back on the same port.
 *
 * Deliberately a *process*, not an embedded `WsTunnel`: killing a process is the
 * only faithful way to reproduce what a deploy, a crash or a machine sleep does
 * to a provider's socket. For the embedded form, see ../embedded/.
 */
import { spawn } from "node:child_process";
import { brokerBinPath } from "../lib/broker-bin.mjs";

/**
 * Spawns a broker whose output is inherited, so its log interleaves with the
 * narration in one terminal.
 *
 * @param {Record<string,string>} env
 * @returns {{ stop(): void, pid: number | undefined }}
 */
export function startBrokerDetached(env) {
    const child = spawn(process.execPath, [brokerBinPath()], {
        stdio: "inherit",
        env: { ...process.env, ...env },
    });

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        // SIGKILL, not SIGINT. SIGINT gives the broker a graceful shutdown, which
        // closes every provider socket politely with code 1000; that is the nice
        // case and it is not the one worth rehearsing. A hard kill is what a
        // crash looks like from a provider's point of view: an abnormal close,
        // code 1006, no reason string.
        child.kill("SIGKILL");
    };

    process.on("exit", stop);
    process.on("SIGINT", () => {
        stop();
        process.exit(130);
    });

    return { stop, pid: child.pid };
}
