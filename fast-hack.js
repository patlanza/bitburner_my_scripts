const HOME = "home";
const WORKER = "fast-hack-worker.js";
const WORKER_RAM = 1.7; // Bitburner v3.0.1: 1.6 base + 0.1 de ns.hack.
const WORKER_SOURCE = `/** @param {NS} ns */
export async function main(ns) {
    await ns.hack(String(ns.args[0]));
}
`;

const FLAGS = [
    ["home-ram-fraction", 0.75],
    ["refill", 500],
    ["rescan", 30000],
    ["min-money", 1],
    ["max-processes", 2000],
    ["allow-conflicts", false],
    ["help", false],
];

const ANSI = {
    reset: "\u001b[0m",
    red: "\u001b[1;31m",
    green: "\u001b[1;32m",
    yellow: "\u001b[1;33m",
    magenta: "\u001b[1;35m",
    cyan: "\u001b[1;36m",
};

const deployedHosts = new Set([HOME]);

/** @param {NS} ns */
export async function main(ns) {
    const options = ns.flags(FLAGS);
    if (options.help) {
        printHelp(ns);
        return;
    }
    if (!validateOptions(ns, options)) return;
    if (ns.getHostname() !== HOME) {
        ns.tprint(`ERROR: ${ns.getScriptName()} debe ejecutarse desde home.`);
        return;
    }

    const duplicate = ns.ps(HOME).find(
        (process) => process.filename === ns.getScriptName() && process.pid !== ns.pid,
    );
    if (duplicate) {
        ns.tprint(`ERROR: ${ns.getScriptName()} ya se ejecuta con PID ${duplicate.pid}.`);
        return;
    }

    ns.disableLog("ALL");
    await createWorker(ns);
    const conflicts = findConflictingCoordinators(ns);
    if (conflicts.length > 0 && !options["allow-conflicts"]) {
        ns.tprint(
            `ERROR: detén primero ${conflicts.map((process) => process.filename).join(", ")} ` +
            "o usa --allow-conflicts true.",
        );
        return;
    }

    const workerRam = WORKER_RAM;

    let nextRootScan = 0;
    let nextIdleLog = 0;
    let wave = 0;
    ns.tprint(`INFO: ${ns.getScriptName()} iniciado en modo hack-only.`);
    log(ns, "FAST", "hack-only activo; no se ejecutarán grow ni weaken.");

    while (true) {
        const now = Date.now();
        const servers = discoverServers(ns);
        if (now >= nextRootScan) {
            const rooted = rootServers(ns, servers);
            if (rooted > 0) log(ns, "ROOT", `acceso obtenido en ${rooted} servidor(es).`);
            nextRootScan = now + options.rescan;
        }

        let hosts = getExecutionHosts(ns, servers, options["home-ram-fraction"], workerRam);
        hosts = await prepareHosts(ns, hosts);
        const activeWorkers = countFastWorkers(ns, servers);
        const processBudget = Math.max(0, options["max-processes"] - activeWorkers);
        const busyTargets = findActiveTargets(ns, servers);
        const targets = getMoneyTargets(ns, servers, busyTargets, options["min-money"]);

        if (processBudget > 0 && hosts.some((host) => host.freeRam >= workerRam) && targets.length > 0) {
            wave++;
            const result = dispatchFastWave(
                ns,
                hosts,
                targets,
                workerRam,
                processBudget,
                wave,
            );
            if (result.processes > 0) {
                log(
                    ns,
                    "OLEADA",
                    `${result.processes} hack(s), ${result.hosts} host(s), ` +
                    `${result.targets} víctima(s), ${ns.format.ram(result.ram)}.`,
                );
            }
        } else if (now >= nextIdleLog) {
            if (targets.length === 0) {
                log(ns, "ESPERA", "no quedan víctimas libres con dinero; se seguirá reintentando.");
            } else if (processBudget === 0) {
                log(ns, "ESPERA", `límite de ${options["max-processes"]} procesos alcanzado.`);
            } else {
                log(ns, "ESPERA", "no hay RAM libre suficiente para otro worker.");
            }
            nextIdleLog = now + 10000;
        }

        await ns.sleep(options.refill);
    }
}

/** @param {NS} ns */
async function createWorker(ns) {
    if (ns.read(WORKER) !== WORKER_SOURCE) await ns.write(WORKER, WORKER_SOURCE, "w");
}

/** @param {NS} ns */
function findConflictingCoordinators(ns) {
    return ns.ps(HOME).filter((process) =>
        process.pid !== ns.pid &&
        /(adaptive-hack|smart-hack|distributed-hack|fast-hack)/i.test(process.filename)
    );
}

/** @param {NS} ns */
function discoverServers(ns) {
    const discovered = new Set([HOME]);
    const pending = [HOME];
    for (let index = 0; index < pending.length; index++) {
        for (const neighbour of ns.scan(pending[index])) {
            if (discovered.has(neighbour)) continue;
            discovered.add(neighbour);
            pending.push(neighbour);
        }
    }
    return discovered;
}

/** @param {NS} ns @param {Set<string>} servers */
function rootServers(ns, servers) {
    const openers = [
        ["BruteSSH.exe", (host) => ns.brutessh(host)],
        ["FTPCrack.exe", (host) => ns.ftpcrack(host)],
        ["relaySMTP.exe", (host) => ns.relaysmtp(host)],
        ["HTTPWorm.exe", (host) => ns.httpworm(host)],
        ["SQLInject.exe", (host) => ns.sqlinject(host)],
    ].filter(([program]) => ns.fileExists(program, HOME));

    let rooted = 0;
    for (const host of servers) {
        if (host === HOME || ns.hasRootAccess(host)) continue;
        for (const [, openPort] of openers) openPort(host);
        if (ns.nuke(host)) rooted++;
    }
    return rooted;
}

/** @param {NS} ns */
function getExecutionHosts(ns, servers, homeFraction, workerRam) {
    const hosts = [];
    for (const host of servers) {
        if (!ns.hasRootAccess(host)) continue;
        const maxRam = ns.getServerMaxRam(host);
        if (maxRam < workerRam) continue;
        const usedRam = ns.getServerUsedRam(host);
        let freeRam = Math.max(0, maxRam - usedRam);
        if (host === HOME) {
            const absoluteLimit = maxRam * homeFraction;
            freeRam = Math.max(0, absoluteLimit - usedRam);
        }
        if (freeRam >= workerRam) hosts.push({ host, freeRam });
    }
    return hosts.sort((a, b) => {
        if (a.host === HOME && b.host !== HOME) return 1;
        if (b.host === HOME && a.host !== HOME) return -1;
        return b.freeRam - a.freeRam;
    });
}

/** @param {NS} ns */
async function prepareHosts(ns, hosts) {
    const ready = [];
    for (const hostInfo of hosts) {
        if (hostInfo.host === HOME) {
            ready.push(hostInfo);
            continue;
        }
        if (!deployedHosts.has(hostInfo.host) || !ns.fileExists(WORKER, hostInfo.host)) {
            if (!await ns.scp(WORKER, hostInfo.host, HOME)) continue;
            deployedHosts.add(hostInfo.host);
        }
        ready.push(hostInfo);
    }
    return ready;
}

/** @param {NS} ns @param {Set<string>} servers */
function countFastWorkers(ns, servers) {
    let count = 0;
    for (const host of servers) {
        if (!ns.hasRootAccess(host)) continue;
        count += ns.ps(host).filter((process) => process.filename === WORKER).length;
    }
    return count;
}

/** @param {NS} ns @param {Set<string>} servers */
function findActiveTargets(ns, servers) {
    const targets = new Set();
    const known = new Set(servers);
    for (const host of servers) {
        if (!ns.hasRootAccess(host)) continue;
        for (const process of ns.ps(host)) {
            if (process.filename === WORKER) {
                const target = String(process.args[0] ?? "");
                if (known.has(target)) targets.add(target);
            } else if (/(hack|grow|weaken|batch)/i.test(process.filename)) {
                for (const argument of process.args) {
                    const target = String(argument);
                    if (known.has(target)) targets.add(target);
                }
            }
        }
    }
    return targets;
}

/** @param {NS} ns */
function getMoneyTargets(ns, servers, busyTargets, minimumMoney) {
    const level = ns.getHackingLevel();
    const targets = [];
    for (const host of servers) {
        if (busyTargets.has(host)) continue;
        if (!ns.hasRootAccess(host)) continue;
        const money = ns.getServerMoneyAvailable(host);
        const maxMoney = ns.getServerMaxMoney(host);
        if (
            money <= minimumMoney ||
            maxMoney <= 0 ||
            ns.getServerRequiredHackingLevel(host) > level
        ) continue;
        const hackPercent = ns.hackAnalyze(host);
        const time = ns.getHackTime(host);
        if (!Number.isFinite(hackPercent) || hackPercent <= 0) continue;
        targets.push({
            host,
            money,
            minimumMoney,
            hackPercent,
            time,
        });
    }
    return targets;
}

/** @param {NS} ns */
function dispatchFastWave(ns, hosts, targets, workerRam, processBudget, wave) {
    let processes = 0;
    let usedRam = 0;
    let job = 0;
    const usedHosts = new Set();
    const usedTargets = new Set();

    for (const hostInfo of hosts) {
        while (processes < processBudget) {
            const capacity = Math.floor(hostInfo.freeRam / workerRam);
            if (capacity < 1) break;
            const available = targets
                .filter((target) => target.money > target.minimumMoney)
                .sort((a, b) =>
                    b.money / Math.max(1, b.time) -
                    a.money / Math.max(1, a.time)
                );
            if (available.length === 0) break;

            const target = available[0];
            const usefulThreads = Math.max(1, Math.floor(0.99 / target.hackPercent));
            const threads = Math.min(capacity, usefulThreads);
            const pid = ns.exec(
                WORKER,
                hostInfo.host,
                threads,
                target.host,
                `fast-${wave}-${job++}`,
            );
            if (pid === 0) break;

            const ram = threads * workerRam;
            hostInfo.freeRam -= ram;
            usedRam += ram;
            processes++;
            usedHosts.add(hostInfo.host);
            usedTargets.add(target.host);
            target.money *= 1 - Math.min(0.99, target.hackPercent * threads);
        }
    }
    return {
        processes,
        hosts: usedHosts.size,
        targets: usedTargets.size,
        ram: usedRam,
    };
}

/** @param {NS} ns */
function validateOptions(ns, options) {
    const numeric = ["home-ram-fraction", "refill", "rescan", "min-money", "max-processes"];
    if (numeric.some((name) => !Number.isFinite(Number(options[name])))) {
        ns.tprint("ERROR: las opciones numéricas deben contener números finitos.");
        return false;
    }
    if (options["home-ram-fraction"] < 0 || options["home-ram-fraction"] > 1) {
        ns.tprint("ERROR: --home-ram-fraction debe estar entre 0 y 1.");
        return false;
    }
    options.refill = Math.max(250, Math.floor(Number(options.refill)));
    options.rescan = Math.max(1000, Math.floor(Number(options.rescan)));
    options["min-money"] = Math.max(0, Number(options["min-money"]));
    options["max-processes"] = Math.max(1, Math.floor(Number(options["max-processes"])));
    return true;
}

/** @param {NS} ns */
function log(ns, label, message) {
    const colors = {
        FAST: ANSI.cyan,
        OLEADA: ANSI.green,
        ROOT: ANSI.green,
        LIMPIEZA: ANSI.green,
        ESPERA: ANSI.yellow,
        ERROR: ANSI.red,
        OBJETIVO: ANSI.magenta,
    };
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
    const color = colors[label] ?? ANSI.cyan;
    ns.print(`[${time}] ${color}${label}:${ANSI.reset} ${message}`);
}

/** @param {NS} ns */
function printHelp(ns) {
    ns.tprint(`Uso: run ${ns.getScriptName()} [opciones]`);
    ns.tprint("  --home-ram-fraction 0.75  Parte de la RAM de home utilizable.");
    ns.tprint("  --refill 500              Revisa RAM y víctimas cada milisegundos.");
    ns.tprint("  --rescan 30000            Reintenta conseguir root cada milisegundos.");
    ns.tprint("  --min-money 1             Descarta víctimas con este dinero o menos.");
    ns.tprint("  --max-processes 2000      Límite global de workers fast.");
    ns.tprint("  --allow-conflicts false   Permite otros coordinadores (arriesgado).");
}
