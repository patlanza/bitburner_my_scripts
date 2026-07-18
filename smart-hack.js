const HOME = "home";

const WORKERS = {
    hack: {
        path: "/smart-hack-workers/hack.js",
        source: `/** @param {NS} ns */
export async function main(ns) {
    await ns.hack(String(ns.args[0]));
}
`,
    },
    grow: {
        path: "/smart-hack-workers/grow.js",
        source: `/** @param {NS} ns */
export async function main(ns) {
    await ns.grow(String(ns.args[0]));
}
`,
    },
    weaken: {
        path: "/smart-hack-workers/weaken.js",
        source: `/** @param {NS} ns */
export async function main(ns) {
    await ns.weaken(String(ns.args[0]));
}
`,
    },
};

const FLAGS = [
    ["target", ""],
    ["hack-fraction", 0.10],
    ["money-threshold", 0.95],
    ["security-buffer", 0.5],
    ["reserve-home", 16],
    ["poll", 200],
    ["help", false],
];

/** @param {NS} ns */
export async function main(ns) {
    const options = ns.flags(FLAGS);

    if (options.help) {
        printHelp(ns);
        return;
    }

    if (ns.getHostname() !== HOME) {
        ns.tprint(`ERROR: ${ns.getScriptName()} debe ejecutarse desde home.`);
        return;
    }

    const duplicate = ns.ps(HOME).find(
        (process) => process.filename === ns.getScriptName() && process.pid !== ns.pid,
    );
    if (duplicate) {
        ns.tprint(
            `ERROR: ${ns.getScriptName()} ya está ejecutándose con PID ${duplicate.pid}.`,
        );
        return;
    }

    if (options["hack-fraction"] <= 0 || options["hack-fraction"] >= 0.9) {
        ns.tprint("ERROR: --hack-fraction debe ser mayor que 0 y menor que 0.9.");
        return;
    }

    if (options["money-threshold"] <= 0 || options["money-threshold"] > 1) {
        ns.tprint("ERROR: --money-threshold debe estar entre 0 y 1.");
        return;
    }

    options["reserve-home"] = Math.max(0, options["reserve-home"]);
    options["security-buffer"] = Math.max(0, options["security-buffer"]);
    options.poll = Math.max(50, options.poll);

    ns.disableLog("ALL");
    await createWorkers(ns);

    ns.tprint(
        `INFO: ${ns.getScriptName()} iniciado. ` +
        `Usa "tail ${ns.getScriptName()}" para ver su actividad.`,
    );
    log(ns, "Coordinador iniciado.");

    while (true) {
        log(ns, "──────── Nuevo ciclo ────────");

        const servers = discoverServers(ns);
        const rooted = rootServers(ns, servers);
        if (rooted > 0) log(ns, `ROOT: acceso obtenido en ${rooted} servidor(es).`);

        const target = chooseTarget(ns, servers, String(options.target));
        if (!target) {
            log(ns, "No hay ningún objetivo hackeable disponible.");
            await ns.sleep(5000);
            continue;
        }

        const action = chooseAction(ns, target, options);
        const hosts = getExecutionHosts(ns, servers, options["reserve-home"]);
        const worker = WORKERS[action.name];
        const workerRam = ns.getScriptRam(worker.path, HOME);
        const capacity = hosts.reduce(
            (total, host) => total + Math.floor(host.freeRam / workerRam),
            0,
        );

        if (capacity < 1) {
            log(ns, "No hay RAM libre suficiente para ejecutar workers.");
            await ns.sleep(1000);
            continue;
        }

        const requestedThreads = Math.max(1, Math.ceil(action.threads));
        const threads = Math.min(requestedThreads, capacity);

        log(ns, `Servidores descubiertos: ${servers.size}`);
        log(ns, `Servidores con RAM utilizable: ${hosts.length}`);
        log(ns, `Objetivo: ${target}`);
        log(ns, `Acción: ${action.name}`);
        log(ns, `Hilos: ${threads}/${requestedThreads} solicitados`);
        log(ns, `Motivo: ${action.reason}`);

        const pids = await deployWorkers(
            ns,
            worker.path,
            target,
            threads,
            hosts,
            workerRam,
        );

        if (pids.length === 0) {
            log(ns, "No se pudo iniciar ningún worker; se reintentará.");
            await ns.sleep(1000);
            continue;
        }

        while (pids.some((pid) => ns.isRunning(pid))) {
            await ns.sleep(options.poll);
        }
    }
}

/** @param {NS} ns */
async function createWorkers(ns) {
    for (const worker of Object.values(WORKERS)) {
        if (ns.read(worker.path) !== worker.source) {
            await ns.write(worker.path, worker.source, "w");
        }
    }
}

/**
 * Escaneo en anchura sin límite de profundidad. Cloud servers se añaden
 * explícitamente aunque una futura topología no los mostrase desde home.
 * @param {NS} ns
 */
function discoverServers(ns) {
    const discovered = new Set([HOME, ...ns.cloud.getServerNames()]);
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
        if (ns.hasRootAccess(host)) continue;

        for (const [, openPort] of openers) openPort(host);
        if (ns.nuke(host)) rooted++;
    }

    return rooted;
}

/**
 * Elige un servidor rentable utilizando sus valores máximos y el tiempo de
 * weaken. Así un servidor temporalmente vacío no queda descartado para siempre.
 * @param {NS} ns
 * @param {Set<string>} servers
 * @param {string} requestedTarget
 */
function chooseTarget(ns, servers, requestedTarget) {
    const hackingLevel = ns.getHackingLevel();
    const candidates = [];

    for (const host of servers) {
        const server = ns.getServer(host);
        if (!server.hasAdminRights) continue;
        if (server.purchasedByPlayer) continue;
        if ((server.moneyMax ?? 0) <= 0) continue;
        if ((server.requiredHackingSkill ?? Infinity) > hackingLevel) continue;

        const chance = ns.hackAnalyzeChance(host);
        const weakenTime = Math.max(1, ns.getWeakenTime(host));
        const growth = Math.max(1, server.serverGrowth ?? 1);
        const minSecurity = Math.max(1, server.minDifficulty ?? 1);
        const score = server.moneyMax * chance * growth / minSecurity / weakenTime;

        candidates.push({ host, score });
    }

    if (requestedTarget) {
        return candidates.some((candidate) => candidate.host === requestedTarget)
            ? requestedTarget
            : "";
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.host ?? "";
}

/** @param {NS} ns @param {string} target @param {Record<string, any>} options */
function chooseAction(ns, target, options) {
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    const securityDifference = security - minSecurity;
    if (securityDifference > options["security-buffer"]) {
        return {
            name: "weaken",
            threads: securityDifference / ns.weakenAnalyze(1, 1),
            reason: `seguridad ${security.toFixed(2)} > ${(minSecurity + options["security-buffer"]).toFixed(2)}`,
        };
    }

    const moneyRatio = money / maxMoney;
    if (moneyRatio < options["money-threshold"]) {
        const multiplier = maxMoney / Math.max(1, money);
        return {
            name: "grow",
            threads: ns.growthAnalyze(target, multiplier, 1),
            reason: `dinero ${ns.format.percent(moneyRatio, 2)} < ${ns.format.percent(options["money-threshold"], 2)}`,
        };
    }

    const hackPerThread = ns.hackAnalyze(target);
    return {
        name: "hack",
        threads: options["hack-fraction"] / hackPerThread,
        reason: `servidor preparado; robar ${ns.format.percent(options["hack-fraction"], 2)}`,
    };
}

/**
 * @param {NS} ns
 * @param {Set<string>} servers
 * @param {number} reserveHome
 */
function getExecutionHosts(ns, servers, reserveHome) {
    const hosts = [];

    for (const host of servers) {
        const server = ns.getServer(host);
        if (!server.hasAdminRights || server.maxRam <= 0) continue;

        const reserve = host === HOME ? reserveHome : 0;
        const freeRam = Math.max(0, server.maxRam - server.ramUsed - reserve);
        if (freeRam > 0) hosts.push({ host, freeRam });
    }

    // Aprovecha primero la RAM remota y deja home para el final. Además de
    // conservar recursos locales, hace que los servidores con root trabajen
    // siempre que la operación necesite hilos suficientes.
    return hosts.sort((a, b) => {
        if (a.host === HOME && b.host !== HOME) return 1;
        if (b.host === HOME && a.host !== HOME) return -1;
        return b.freeRam - a.freeRam;
    });
}

/**
 * @param {NS} ns
 * @param {string} script
 * @param {string} target
 * @param {number} requestedThreads
 * @param {{host: string, freeRam: number}[]} hosts
 * @param {number} scriptRam
 */
async function deployWorkers(ns, script, target, requestedThreads, hosts, scriptRam) {
    const pids = [];
    let remaining = requestedThreads;

    for (const { host, freeRam } of hosts) {
        if (remaining <= 0) break;

        const threads = Math.min(remaining, Math.floor(freeRam / scriptRam));
        if (threads < 1) continue;

        if (host !== HOME && !await ns.scp(script, host, HOME)) {
            log(ns, `SCP falló para ${host}.`);
            continue;
        }

        const pid = ns.exec(script, host, threads, target);
        if (pid === 0) {
            log(ns, `EXEC falló para ${host} con ${threads} hilos.`);
            continue;
        }

        pids.push(pid);
        remaining -= threads;
        log(ns, `DESPLIEGUE: ${host} ejecuta ${script} con ${threads} hilo(s).`);
    }

    return pids;
}

/** @param {NS} ns @param {string} message */
function log(ns, message) {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
    ns.print(`[${time}] ${message}`);
}

/** @param {NS} ns */
function printHelp(ns) {
    ns.tprint(`Uso: run ${ns.getScriptName()} [opciones]`);
    ns.tprint("  --target SERVIDOR       Fija el objetivo; vacío elige el mejor.");
    ns.tprint("  --hack-fraction 0.10    Fracción de dinero robada por ciclo.");
    ns.tprint("  --money-threshold 0.95  Dinero mínimo antes de hackear.");
    ns.tprint("  --security-buffer 0.5   Margen sobre la seguridad mínima.");
    ns.tprint("  --reserve-home 16       RAM de home que no utilizará, en GB.");
    ns.tprint("  --poll 200              Intervalo de espera de workers, en ms.");
}

export function autocomplete(data, args) {
    data.flags(FLAGS);
    const previous = args.at(-2);
    return previous === "--target" ? data.servers : [];
}
