import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packagePath = "packages/broker/package.json";
const packageName = "@cyanmycelium/mcp-broker";

process.chdir(workspaceRoot);

function run(command, args) {
    execFileSync(command, args, { stdio: "inherit" });
}

function readVersion() {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
    if (match === null) {
        throw new Error(`Unsupported broker version: ${packageJson.version}`);
    }
    return {
        current: packageJson.version,
        next: `${match[1]}.${Number(match[2]) + 1}.0`,
    };
}

const status = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
});
if (status.trim() !== "") {
    throw new Error("Refusing to bump mcp-broker from a dirty Git worktree");
}

const { current, next } = readVersion();
const tag = `node-v${next}`;
const existingTag = spawnSync(
    "git",
    ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`],
    { stdio: "ignore" },
);
if (existingTag.status === 0) {
    throw new Error(`Refusing to overwrite existing tag ${tag}`);
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli === "") {
    throw new Error("npm_execpath is unavailable, run this helper through npm");
}
run(process.execPath, [
    npmCli,
    "version",
    next,
    "--workspace",
    packageName,
    "--no-git-tag-version",
]);

const updated = readVersion().current;
if (updated !== next) {
    throw new Error(`Expected broker version ${next}, found ${updated}`);
}

run("git", ["add", packagePath, "package-lock.json"]);
run("git", ["commit", "-m", `release broker ${next}`]);
run("git", ["tag", tag]);

console.log(`Bumped ${packageName} from ${current} to ${next}`);
console.log(`Created commit release broker ${next}`);
console.log(`Created tag ${tag}`);
