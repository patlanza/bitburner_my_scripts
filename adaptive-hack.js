const HOME = "home";
const FORMULAS = "Formulas.exe";

const ANSI = {
    reset: "\u001b[0m",
    boldRed: "\u001b[1;31m",
    boldGreen: "\u001b[1;32m",
    boldYellow: "\u001b[1;33m",
    boldBlue: "\u001b[1;34m",
    boldMagenta: "\u001b[1;35m",
    boldCyan: "\u001b[1;36m",
};

const LOG_STYLE_RULES = [
    [/^(CICLO \d+:)/, ANSI.boldCyan],
    [/^(OBJETIVO:)/, ANSI.boldMagenta],
    [/^(ROOT(?: durante ejecución)?:|LIMPIEZA:)/, ANSI.boldGreen],
    [/^(ETAPA PREP:)/, ANSI.boldYellow],
    [/^(ETAPA RELLENO:)/, ANSI.boldBlue],
    [/^(ETAPA (?:SHOTGUN|PROTO-BATCH|CONTROLLER):)/, ANSI.boldGreen],
    [/^(AVISO:|PREP incompleta:|Sin RAM|No hay ninguna víctima)/, ANSI.boldYellow],
    [/^(BATCH \d+ incompleto|EXEC falló:|SCP falló|No se pudo iniciar)/, ANSI.boldRed],
    [/^(Coordinador adaptativo iniciado\.)/, ANSI.boldCyan],
];

const WORKERS = {
    hack: {
        path: "adaptive-hack-workers/hack.js",
        source: `/** @param {NS} ns */
export async function main(ns) {
    const target = String(ns.args[0]);
    const landingTime = Number(ns.args[1]) || 0;
    const baseTime = ns.getHackTime(target);
    const additionalMsec = landingTime > 0
        ? Math.max(0, landingTime - Date.now() - baseTime)
        : 0;
    await ns.hack(target, { additionalMsec });
}
`,
    },
    grow: {
        path: "adaptive-hack-workers/grow.js",
        source: `/** @param {NS} ns */
export async function main(ns) {
    const target = String(ns.args[0]);
    const landingTime = Number(ns.args[1]) || 0;
    const baseTime = ns.getGrowTime(target);
    const additionalMsec = landingTime > 0
        ? Math.max(0, landingTime - Date.now() - baseTime)
        : 0;
    await ns.grow(target, { additionalMsec });
}
`,
    },
    weaken: {
        path: "adaptive-hack-workers/weaken.js",
        source: `/** @param {NS} ns */
export async function main(ns) {
    const target = String(ns.args[0]);
    const landingTime = Number(ns.args[1]) || 0;
    const baseTime = ns.getWeakenTime(target);
    const additionalMsec = landingTime > 0
        ? Math.max(0, landingTime - Date.now() - baseTime)
        : 0;
    await ns.weaken(target, { additionalMsec });
}
`,
    },
};

const FLAGS = [
    ["target", ""],
    ["strategy", "auto"],
    ["home-ram-fraction", 0.75],
    ["hack-fraction", 0],
    ["max-hack-fraction", 0.8],
    ["money-threshold", 0.999999],
    ["security-tolerance", 0.0001],
    ["batch-gap", 80],
    ["launch-buffer", 1000],
    ["max-batches", 200],
    ["max-processes", 2000],
    ["poll", 100],
    ["refill", 1000],
    ["rescan", 30000],
    ["fill-idle-ram", true],
    ["avoid-busy-targets", true],
    ["allow-conflicts", false],
    ["help", false],
];

const deployedHosts = new Set([HOME]);
let learnedLaunchMsPerProcess = 2;

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
    await createWorkers(ns);
    const conflicts = warnAboutOtherCoordinators(ns);
    if (conflicts > 0 && !options["allow-conflicts"]) {
        ns.tprint(
            "ERROR: detén los otros coordinadores o usa --allow-conflicts true bajo tu responsabilidad.",
        );
        return;
    }
    const stoppedWorkers = stopOrphanedWorkers(ns, discoverServers(ns));
    if (stoppedWorkers > 0) {
        log(ns, `LIMPIEZA: detenidos ${stoppedWorkers} worker(s) de ejecuciones anteriores.`);
    }

    let previousTarget = "";
    let previousFormulasState = null;
    let cycle = 0;

    ns.tprint(
        `INFO: ${ns.getScriptName()} iniciado. Usa "tail ${ns.getScriptName()}" para seguirlo.`,
    );
    log(ns, "Coordinador adaptativo iniciado.");

    while (true) {
        cycle++;
        const servers = discoverServers(ns);
        const rooted = rootServers(ns, servers);
        if (rooted > 0) log(ns, `ROOT: acceso obtenido en ${rooted} servidor(es).`);

        let hosts = getExecutionHosts(ns, servers, options["home-ram-fraction"]);
        hosts = await prepareExecutionHosts(ns, hosts);
        const totalRam = hosts.reduce((sum, host) => sum + host.freeRam, 0);
        if (!hasWorkerCapacity(ns, hosts)) {
            log(ns, "Sin RAM suficiente para iniciar un worker.");
            await ns.sleep(1000);
            continue;
        }

        const hasFormulas = ns.fileExists(FORMULAS, HOME);
        if (hasFormulas !== previousFormulasState) {
            log(
                ns,
                hasFormulas
                    ? "Formulas.exe detectado: selección y batches con simulación exacta."
                    : "Formulas.exe no disponible: se usarán análisis básicos conservadores.",
            );
            previousFormulasState = hasFormulas;
        }

        const workerRam = getWorkerRam(ns);
        const busyTargets = findBusyTargets(
            ns,
            servers,
            options["avoid-busy-targets"],
        );
        const selection = chooseTarget(
            ns,
            servers,
            String(options.target),
            busyTargets,
            totalRam,
            workerRam,
            options,
            hasFormulas,
            hosts,
        );

        if (!selection) {
            log(ns, "No hay ninguna víctima válida y libre.");
            await ns.sleep(5000);
            continue;
        }

        const target = selection.host;
        if (target !== previousTarget) {
            log(
                ns,
                `OBJETIVO: ${target} (${hasFormulas ? "Formulas.exe + simulación de RAM" : "puntuación aproximada"}).`,
            );
            previousTarget = target;
        }

        const targetServer = ns.getServer(target);
        const securityGap = targetServer.hackDifficulty - targetServer.minDifficulty;
        const moneyRatio = targetServer.moneyAvailable / targetServer.moneyMax;
        log(
            ns,
            `CICLO ${cycle}: RAM ${ns.format.ram(totalRam)}, ` +
            `${target} dinero ${ns.format.percent(moneyRatio, 2)}, ` +
            `seguridad +${securityGap.toFixed(4)}.`,
        );

        let primaryPids = [];
        if (securityGap > options["security-tolerance"]) {
            primaryPids = await runSecurityPrep(ns, targetServer, hosts, workerRam);
        } else if (moneyRatio < options["money-threshold"]) {
            primaryPids = await runMoneyPrep(
                ns,
                targetServer,
                hosts,
                workerRam,
                hasFormulas,
            );
        } else {
            const plan = selection.plan ?? buildBestBatchPlan(
                ns,
                targetServer,
                totalRam,
                workerRam,
                options,
                hasFormulas,
                hosts,
            );
            const batchingAllowed = options.strategy !== "controller";

            if (batchingAllowed && plan?.recommendedBatches > 0) {
                primaryPids = await runBatchWave(ns, targetServer, hosts, plan, options);
            }

            if (primaryPids.length === 0) {
                primaryPids = await runControllerHack(
                    ns,
                    targetServer,
                    hosts,
                    workerRam,
                    options,
                );
            }
        }

        let fillerPids = [];
        const processBudget = Math.max(
            0,
            options["max-processes"] - countActiveWorkers(ns, servers),
        );
        if (options["fill-idle-ram"] && processBudget > 0) {
            fillerPids = await runIdleFill(
                ns,
                servers,
                hosts,
                workerRam,
                target,
                busyTargets,
                options,
                processBudget,
            );
        }

        if (primaryPids.length === 0) {
            if (fillerPids.length > 0) {
                await ns.sleep(options.refill);
                continue;
            }
            log(ns, "No se pudo iniciar trabajo; se reintentará.");
            await ns.sleep(1000);
            continue;
        }

        await maintainUtilization(ns, primaryPids, target, workerRam, options);
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

/** @param {NS} ns @param {Set<string>} servers */
function stopOrphanedWorkers(ns, servers) {
    const workerPaths = new Set(Object.values(WORKERS).map((worker) => worker.path));
    let stopped = 0;
    for (const host of servers) {
        if (!ns.hasRootAccess(host)) continue;
        for (const process of ns.ps(host)) {
            if (workerPaths.has(process.filename) && ns.kill(process.pid)) stopped++;
        }
    }
    return stopped;
}

/** @param {NS} ns */
function getWorkerRam(ns) {
    const ram = {};
    for (const [name, worker] of Object.entries(WORKERS)) {
        worker.ram = ns.getScriptRam(worker.path, HOME);
        ram[name] = worker.ram;
    }
    return ram;
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

/**
 * @param {NS} ns
 * @param {Set<string>} servers
 * @param {number} homeRamFraction
 */
function getExecutionHosts(ns, servers, homeRamFraction) {
    const hosts = [];
    for (const host of servers) {
        const server = ns.getServer(host);
        if (!server.hasAdminRights || server.maxRam <= 0) continue;
        const availableRam = Math.max(0, server.maxRam - server.ramUsed);
        let freeRam = availableRam;
        if (host === HOME) {
            const absoluteLimit = server.maxRam * homeRamFraction;
            freeRam = Math.max(0, absoluteLimit - server.ramUsed);
        }
        if (freeRam > 0) {
            const cpuCores = Math.max(1, server.cpuCores ?? 1);
            hosts.push({
                host,
                freeRam,
                cpuCores,
                weakenPerThread: ns.weakenAnalyze(1, cpuCores),
            });
        }
    }

    return hosts.sort((a, b) => {
        if (a.host === HOME && b.host !== HOME) return 1;
        if (b.host === HOME && a.host !== HOME) return -1;
        return b.freeRam - a.freeRam;
    });
}

/** @param {NS} ns @param {{host:string,freeRam:number,cpuCores:number}[]} hosts */
async function prepareExecutionHosts(ns, hosts) {
    const paths = Object.values(WORKERS).map((worker) => worker.path);
    const ready = [];
    for (const hostInfo of hosts) {
        if (hostInfo.host === HOME) {
            ready.push(hostInfo);
            continue;
        }

        const missingWorker = paths.some((path) => !ns.fileExists(path, hostInfo.host));
        if (!deployedHosts.has(hostInfo.host) || missingWorker) {
            if (!await ns.scp(paths, hostInfo.host, HOME)) {
                log(ns, `SCP falló para ${hostInfo.host}; se excluye este ciclo.`);
                continue;
            }
            deployedHosts.add(hostInfo.host);
        }
        ready.push(hostInfo);
    }
    return ready;
}

/** @param {NS} ns @param {{host:string,freeRam:number}[]} hosts */
function hasWorkerCapacity(ns, hosts) {
    const cheapest = Math.min(...Object.values(getWorkerRam(ns)));
    return hosts.some((host) => host.freeRam >= cheapest);
}

/**
 * @param {NS} ns
 * @param {Set<string>} servers
 * @param {string} requestedTarget
 * @param {Set<string>} busyTargets
 * @param {number} totalRam
 * @param {Record<string,number>} workerRam
 * @param {Record<string,any>} options
 * @param {boolean} hasFormulas
 * @param {{host:string,freeRam:number,cpuCores:number}[]} executionHosts
 */
function chooseTarget(
    ns,
    servers,
    requestedTarget,
    busyTargets,
    totalRam,
    workerRam,
    options,
    hasFormulas,
    executionHosts,
) {
    const hackingLevel = ns.getHackingLevel();
    const candidates = [];
    for (const host of servers) {
        const server = ns.getServer(host);
        if (!server.hasAdminRights || server.purchasedByPlayer) continue;
        if ((server.moneyMax ?? 0) <= 0 || (server.serverGrowth ?? 0) <= 0) continue;
        if ((server.requiredHackingSkill ?? Infinity) > hackingLevel) continue;
        if (!requestedTarget && busyTargets.has(host)) continue;

        let score;
        let plan = null;
        if (hasFormulas) {
            plan = buildBestBatchPlan(
                ns,
                server,
                totalRam,
                workerRam,
                options,
                true,
            );
            score = plan?.score ?? 0;
        } else {
            const skillPenalty = server.requiredHackingSkill > hackingLevel / 2 ? 0.5 : 1;
            score = server.moneyMax * Math.sqrt(server.serverGrowth) * skillPenalty /
                Math.max(1, server.minDifficulty);
        }
        candidates.push({ host, score, plan, server });
    }

    if (requestedTarget) {
        const requested = candidates.find((candidate) => candidate.host === requestedTarget) ?? null;
        if (requested && hasFormulas) {
            requested.plan = buildBestBatchPlan(
                ns,
                requested.server,
                totalRam,
                workerRam,
                options,
                true,
                executionHosts,
            );
            requested.score = requested.plan?.score ?? requested.score;
        }
        return requested;
    }

    // El cálculo agregado es barato y permite descartar la mayoría. Para los
    // mejores candidatos se simula después la fragmentación real de hosts.
    candidates.sort((a, b) => b.score - a.score);
    if (hasFormulas) {
        const finalists = candidates.slice(0, Math.min(5, candidates.length));
        for (const candidate of finalists) {
            candidate.plan = buildBestBatchPlan(
                ns,
                candidate.server,
                totalRam,
                workerRam,
                options,
                true,
                executionHosts,
            );
            candidate.score = candidate.plan?.score ?? 0;
        }
        finalists.sort((a, b) => b.score - a.score);
        return finalists[0] ?? null;
    }
    return candidates[0] ?? null;
}

/**
 * @param {NS} ns
 * @param {Server} server
 * @param {number} totalRam
 * @param {Record<string,number>} workerRam
 * @param {Record<string,any>} options
 * @param {boolean} hasFormulas
 */
function buildBestBatchPlan(
    ns,
    server,
    totalRam,
    workerRam,
    options,
    hasFormulas,
    hosts = null,
) {
    const fractions = options["hack-fraction"] > 0
        ? [options["hack-fraction"]]
        : getCandidateFractions(options["max-hack-fraction"]);
    const uniquePlans = new Map();

    for (const fraction of fractions) {
        if (fraction <= 0 || fraction > options["max-hack-fraction"]) continue;
        const plan = buildBatchPlan(
            ns,
            server,
            fraction,
            totalRam,
            workerRam,
            options,
            hasFormulas,
            hosts,
        );
        if (!plan) continue;
        const existing = uniquePlans.get(plan.hackThreads);
        if (!existing || plan.score > existing.score) {
            uniquePlans.set(plan.hackThreads, plan);
        }
    }

    return [...uniquePlans.values()].sort((a, b) => {
        const fitDifference = Number(b.recommendedBatches > 0) -
            Number(a.recommendedBatches > 0);
        return fitDifference || b.score - a.score;
    })[0] ?? null;
}

/** @param {number} maximum */
function getCandidateFractions(maximum) {
    const fractions = new Set([0.001, 0.002, 0.005, maximum]);
    for (let percent = 1; percent <= Math.floor(maximum * 100); percent++) {
        fractions.add(percent / 100);
    }
    return [...fractions].filter((fraction) => fraction > 0 && fraction <= maximum);
}

/**
 * @param {NS} ns
 * @param {Server} server
 * @param {number} desiredFraction
 * @param {number} totalRam
 * @param {Record<string,number>} workerRam
 * @param {Record<string,any>} options
 * @param {boolean} hasFormulas
 */
function buildBatchPlan(
    ns,
    server,
    desiredFraction,
    totalRam,
    workerRam,
    options,
    hasFormulas,
    hosts = null,
) {
    const prepped = {
        ...server,
        moneyAvailable: server.moneyMax,
        hackDifficulty: server.minDifficulty,
    };
    const player = ns.getPlayer();
    const hackPercent = hasFormulas
        ? ns.formulas.hacking.hackPercent(prepped, player)
        : ns.hackAnalyze(server.hostname);
    if (!Number.isFinite(hackPercent) || hackPercent <= 0 || hackPercent >= 0.99) return null;

    const maxHackThreads = Math.floor(options["max-hack-fraction"] / hackPercent);
    if (maxHackThreads < 1) return null;
    const hackThreads = Math.max(
        1,
        Math.min(maxHackThreads, Math.floor(desiredFraction / hackPercent)),
    );
    const actualFraction = Math.min(0.99, hackThreads * hackPercent);
    if (actualFraction <= 0 || actualFraction >= 0.99) return null;

    const postHack = {
        ...prepped,
        moneyAvailable: prepped.moneyMax * (1 - actualFraction),
    };
    const growThreads = hasFormulas
        ? ns.formulas.hacking.growThreads(postHack, player, prepped.moneyMax, 1)
        : Math.ceil(ns.growthAnalyze(server.hostname, 1 / (1 - actualFraction), 1));
    if (!Number.isFinite(growThreads) || growThreads < 1) return null;

    const weakenPerThread = ns.weakenAnalyze(1, 1);
    const hackSecurity = ns.hackAnalyzeSecurity(hackThreads);
    const growSecurity = ns.growthAnalyzeSecurity(growThreads);
    const weakenHackThreads = Math.ceil(hackSecurity / weakenPerThread);
    const weakenGrowThreads = Math.ceil(growSecurity / weakenPerThread);
    const batchRam =
        hackThreads * workerRam.hack +
        growThreads * workerRam.grow +
        (weakenHackThreads + weakenGrowThreads) * workerRam.weaken;
    if (!Number.isFinite(batchRam) || batchRam <= 0) return null;

    const hackTime = hasFormulas
        ? ns.formulas.hacking.hackTime(prepped, player)
        : ns.getHackTime(server.hostname);
    const growTime = hasFormulas
        ? ns.formulas.hacking.growTime(prepped, player)
        : ns.getGrowTime(server.hostname);
    const weakenTime = hasFormulas
        ? ns.formulas.hacking.weakenTime(prepped, player)
        : ns.getWeakenTime(server.hostname);
    const chance = hasFormulas
        ? ns.formulas.hacking.hackChance(prepped, player)
        : ns.hackAnalyzeChance(server.hostname);

    const operationTemplate = createBatchOperations({
        hackThreads,
        growThreads,
        weakenHackThreads,
        weakenGrowThreads,
        hackSecurity,
        growSecurity,
    });
    const packing = hosts
        ? simulateBatchPacking(
            hosts,
            operationTemplate,
            options["max-batches"],
            options["max-processes"],
        )
        : {
            batches: Math.min(
                options["max-batches"],
                Math.floor(totalRam / batchRam),
            ),
            processes: 0,
            firstBatchRam: batchRam,
        };
    const recommendedBatches = packing.batches;
    const estimatedProcesses = packing.processes > 0
        ? packing.processes
        : recommendedBatches * 4;
    const launchBuffer = Math.max(
        options["launch-buffer"],
        Math.ceil(estimatedProcesses * learnedLaunchMsPerProcess * 1.5 + 100),
    );
    const stride = options["batch-gap"] * 4;
    const cycleTime = launchBuffer + weakenTime +
        Math.max(0, recommendedBatches - 1) * stride +
        options["batch-gap"] * 3;
    const expectedMoney = prepped.moneyMax * actualFraction * chance;
    const ramTime =
        hackThreads * workerRam.hack * hackTime +
        growThreads * workerRam.grow * growTime +
        (weakenHackThreads + weakenGrowThreads) * workerRam.weaken * weakenTime;
    const score = recommendedBatches > 0
        ? expectedMoney * recommendedBatches / Math.max(1, cycleTime)
        : expectedMoney / Math.max(1, ramTime);

    return {
        target: server.hostname,
        hackThreads,
        growThreads,
        weakenHackThreads,
        weakenGrowThreads,
        hackSecurity,
        growSecurity,
        actualFraction,
        chance,
        batchRam: packing.firstBatchRam || batchRam,
        hackTime,
        growTime,
        weakenTime,
        launchBuffer,
        estimatedProcesses,
        recommendedBatches,
        score,
    };
}

/**
 * Hack y grow deben ser una única llamada. Dividir cualquiera de las dos
 * cambia el resultado matemático y, en hack, añade tiradas de éxito separadas.
 * Weaken sí es lineal y puede repartirse con seguridad.
 * @param {{hackThreads:number,growThreads:number,weakenHackThreads:number,weakenGrowThreads:number,hackSecurity?:number,growSecurity?:number}} plan
 */
function createBatchOperations(plan) {
    return [
        {
            id: "hack",
            type: "hack",
            threads: plan.hackThreads,
            delay: 0,
            singleProcess: true,
        },
        {
            id: "weaken-hack",
            type: "weaken",
            threads: plan.weakenHackThreads,
            securityEffect: plan.hackSecurity,
            delay: 0,
        },
        {
            id: "grow",
            type: "grow",
            threads: plan.growThreads,
            delay: 0,
            singleProcess: true,
        },
        {
            id: "weaken-grow",
            type: "weaken",
            threads: plan.weakenGrowThreads,
            securityEffect: plan.growSecurity,
            delay: 0,
        },
    ];
}

/**
 * @param {NS} ns
 * @param {Server} server
 * @param {{host:string,freeRam:number,cpuCores:number}[]} hosts
 * @param {Record<string,number>} workerRam
 */
async function runSecurityPrep(ns, server, hosts, workerRam) {
    const difference = Math.max(0, server.hackDifficulty - server.minDifficulty);
    const requested = Math.ceil(difference / ns.weakenAnalyze(1, 1));
    let threads = requested;
    let operation = {
        id: "prep-weaken",
        type: "weaken",
        threads,
        securityEffect: difference,
        delay: 0,
    };
    let reservation = reserveOperations(hosts, [operation]);
    if (!reservation) {
        threads = Math.min(requested, getThreadCapacity(hosts, workerRam.weaken));
        if (threads < 1) return [];
        operation = { id: "prep-weaken", type: "weaken", threads, delay: 0 };
        reservation = reserveOperations(hosts, [operation]);
    }
    if (!reservation) return [];
    const actualThreads = reservation[0].allocations.reduce(
        (total, allocation) => total + allocation.threads,
        0,
    );
    const prepHosts = new Set(reservation[0].allocations.map((allocation) => allocation.host));
    log(
        ns,
        `ETAPA PREP: weaken ${server.hostname}, ${actualThreads}/${requested} hilo(s), ` +
        `${prepHosts.size} host(s).`,
    );
    const launch = await launchReservation(
        ns,
        server.hostname,
        reservation,
        `prep-sec-${Date.now()}`,
    );
    return launch.pids;
}

/**
 * @param {NS} ns
 * @param {Server} server
 * @param {{host:string,freeRam:number,cpuCores:number}[]} hosts
 * @param {Record<string,number>} workerRam
 * @param {boolean} hasFormulas
 */
async function runMoneyPrep(ns, server, hosts, workerRam, hasFormulas) {
    const player = ns.getPlayer();
    let requestedGrow = hasFormulas
        ? ns.formulas.hacking.growThreads(server, player, server.moneyMax, 1)
        : Math.ceil(ns.growthAnalyze(
            server.hostname,
            server.moneyMax / Math.max(1, server.moneyAvailable),
            1,
        ));
    if (!Number.isFinite(requestedGrow)) {
        requestedGrow = getThreadCapacity(hosts, workerRam.grow);
    }
    requestedGrow = Math.max(1, Math.ceil(requestedGrow));

    const weakenPerThread = ns.weakenAnalyze(1, 1);
    const operationFactory = (growThreads) => {
        const securityEffect = ns.growthAnalyzeSecurity(growThreads);
        const weakenThreads = Math.ceil(securityEffect / weakenPerThread);
        return [
            {
                id: "prep-grow",
                type: "grow",
                threads: growThreads,
                delay: 0,
            },
            {
                id: "prep-grow-weaken",
                type: "weaken",
                threads: weakenThreads,
                securityEffect,
                delay: 0,
            },
        ];
    };

    const growThreads = findMaxFittingThreads(hosts, requestedGrow, operationFactory);
    let operations;
    if (growThreads > 0) {
        operations = operationFactory(growThreads);
    } else {
        const growOnly = Math.min(requestedGrow, getThreadCapacity(hosts, workerRam.grow));
        if (growOnly < 1) return [];
        operations = [{
            id: "prep-grow",
            type: "grow",
            threads: growOnly,
            delay: 0,
        }];
    }

    const reservation = reserveOperations(hosts, operations);
    if (!reservation) return [];
    const actualGrow = reservation
        .find((item) => item.operation.type === "grow")
        .allocations.reduce((total, allocation) => total + allocation.threads, 0);
    const actualWeaken = reservation
        .filter((item) => item.operation.type === "weaken")
        .flatMap((item) => item.allocations)
        .reduce((total, allocation) => total + allocation.threads, 0);
    const prepHosts = new Set(
        reservation.flatMap((item) => item.allocations.map((allocation) => allocation.host)),
    );
    log(
        ns,
        `ETAPA PREP: grow ${server.hostname}, ${actualGrow}/${requestedGrow} hilo(s)` +
        (actualWeaken > 0 ? ` + weaken ${actualWeaken}` : "") +
        `, ${prepHosts.size} host(s).`,
    );
    const launch = await launchReservation(
        ns,
        server.hostname,
        reservation,
        `prep-money-${Date.now()}`,
    );
    if (!launch.complete) log(ns, "PREP incompleta: se recalculará el estado al terminar.");
    return launch.pids;
}

/**
 * @param {NS} ns
 * @param {Server} server
 * @param {{host:string,freeRam:number,cpuCores:number}[]} hosts
 * @param {ReturnType<buildBatchPlan>} plan
 * @param {Record<string,any>} options
 */
async function runBatchWave(ns, server, hosts, plan, options) {
    const pids = [];
    const usedHosts = new Set();
    let launchedBatches = 0;
    let hadTimingMiss = false;
    let launchedProcesses = 0;
    const waveId = Date.now();
    const waveStart = Date.now();
    const stride = options["batch-gap"] * 4;

    for (let batch = 0; batch < plan.recommendedBatches; batch++) {
        const offset = batch * stride;
        const operations = createBatchOperations(plan);
        operations[0].id = `h-${batch}`;
        operations[0].baseTime = plan.hackTime;
        operations[0].delay = plan.launchBuffer +
            Math.max(0, plan.weakenTime - plan.hackTime) + offset;
        operations[1].id = `w1-${batch}`;
        operations[1].baseTime = plan.weakenTime;
        operations[1].delay = plan.launchBuffer + options["batch-gap"] + offset;
        operations[2].id = `g-${batch}`;
        operations[2].baseTime = plan.growTime;
        operations[2].delay = plan.launchBuffer +
            Math.max(0, plan.weakenTime - plan.growTime) +
            options["batch-gap"] * 2 + offset;
        operations[3].id = `w2-${batch}`;
        operations[3].baseTime = plan.weakenTime;
        operations[3].delay = plan.launchBuffer + options["batch-gap"] * 3 + offset;
        const ramBeforeReservation = hosts.map((host) => host.freeRam);
        const reservation = reserveOperations(hosts, operations);
        if (!reservation) break;
        const reservedProcesses = reservation.reduce(
            (total, item) => total + item.allocations.length,
            0,
        );
        if (launchedProcesses + reservedProcesses > options["max-processes"]) {
            for (let index = 0; index < hosts.length; index++) {
                hosts[index].freeRam = ramBeforeReservation[index];
            }
            break;
        }

        const launch = await launchReservation(
            ns,
            server.hostname,
            reservation,
            `wave-${waveId}-batch-${batch}`,
            waveStart,
        );
        for (const item of reservation) {
            for (const allocation of item.allocations) usedHosts.add(allocation.host);
        }
        pids.push(...launch.pids);
        launchedProcesses += launch.pids.length;
        if (!launch.complete) {
            hadTimingMiss ||= launch.timingMisses > 0;
            log(
                ns,
                `BATCH ${batch} incompleto (${launch.failures} fallo(s), ` +
                `${launch.timingMisses} retraso(s)); se cancela el resto de la oleada.`,
            );
            break;
        }
        launchedBatches++;
    }

    if (launchedBatches > 0) {
        const stage = launchedBatches === 1 ? "PROTO-BATCH" : "SHOTGUN";
        log(
            ns,
            `ETAPA ${stage}: ${launchedBatches} batch(es) HWGW contra ${server.hostname}; ` +
            `${ns.format.percent(plan.actualFraction, 2)} por hack, ` +
            `probabilidad ${ns.format.percent(plan.chance, 2)}, ` +
            `${ns.format.ram(plan.batchRam)} por batch, ` +
            `${pids.length} proceso(s) en ${usedHosts.size} host(s).`,
        );
    }
    const launchDuration = Date.now() - waveStart;
    if (pids.length > 0) {
        const measured = launchDuration / pids.length;
        learnedLaunchMsPerProcess = Math.max(
            0.25,
            learnedLaunchMsPerProcess * 0.8 + measured * 0.2,
        );
    }
    if (hadTimingMiss) learnedLaunchMsPerProcess *= 2;
    return pids;
}

/**
 * @param {NS} ns
 * @param {Server} server
 * @param {{host:string,freeRam:number,cpuCores:number}[]} hosts
 * @param {Record<string,number>} workerRam
 * @param {Record<string,any>} options
 */
async function runControllerHack(ns, server, hosts, workerRam, options) {
    const hackPercent = ns.hackAnalyze(server.hostname);
    if (!Number.isFinite(hackPercent) || hackPercent <= 0) return [];

    const desiredFraction = options["hack-fraction"] > 0
        ? options["hack-fraction"]
        : Math.min(0.1, options["max-hack-fraction"]);
    let requested = Math.floor(desiredFraction / hackPercent);
    if (requested < 1) requested = 1;
    const safeMaximum = Math.max(1, Math.floor(0.99 / hackPercent));
    requested = Math.min(requested, safeMaximum);

    const threads = Math.min(requested, getMaxSingleProcessThreads(hosts, workerRam.hack));
    if (threads < 1) return [];
    const reservation = reserveOperations(hosts, [
        {
            id: "controller-hack",
            type: "hack",
            threads,
            delay: 0,
            singleProcess: true,
        },
    ]);
    if (!reservation) return [];
    log(
        ns,
        `ETAPA CONTROLLER: hack ${server.hostname}, ${threads}/${requested} hilo(s).`,
    );
    const launch = await launchReservation(
        ns,
        server.hostname,
        reservation,
        `controller-${Date.now()}`,
    );
    return launch.pids;
}

/**
 * Usa los huecos que deja el plan principal con trabajo no sincronizado sobre
 * objetivos secundarios. Nunca toca la victima principal, por lo que no puede
 * romper sus batches HWGW. Es deliberadamente conservador con cada hack y
 * vuelve a medir todos los estados en el ciclo siguiente.
 * @param {NS} ns
 * @param {Set<string>} servers
 * @param {{host:string,freeRam:number,cpuCores:number,weakenPerThread:number}[]} hosts
 * @param {Record<string,number>} workerRam
 * @param {string} primaryTarget
 * @param {Set<string>} busyTargets
 * @param {Record<string,any>} options
 * @param {number} processBudget
 */
async function runIdleFill(
    ns,
    servers,
    hosts,
    workerRam,
    primaryTarget,
    busyTargets,
    options,
    processBudget,
) {
    if (processBudget < 1) return [];
    const hackingLevel = ns.getHackingLevel();
    // Concentrar el relleno en los mejores secundarios evita que un objetivo
    // muy lento retrase toda la siguiente reevaluacion del coordinador.
    const targets = [...servers]
        .filter((host) => host !== primaryTarget && !busyTargets.has(host))
        .map((host) => ns.getServer(host))
        .filter((server) =>
            server.hasAdminRights &&
            server.moneyMax > 0 &&
            server.requiredHackingSkill <= hackingLevel
        )
        .map((server) => ({
            ...server,
            score: server.moneyMax * Math.max(0.01, ns.hackAnalyzeChance(server.hostname)) /
                Math.max(1, ns.getWeakenTime(server.hostname)),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    if (targets.length === 0) return [];

    const reservationsByTarget = new Map();
    const usedHosts = new Set();
    const usedTargets = new Set();
    let usedRam = 0;
    let plannedProcesses = 0;
    let cursor = 0;
    let jobId = 0;

    for (const hostInfo of hosts) {
        let misses = 0;
        while (plannedProcesses < processBudget && misses < targets.length) {
            const target = targets[cursor++ % targets.length];
            const job = planFillerJob(ns, target, hostInfo, workerRam, options);
            if (!job) {
                misses++;
                continue;
            }

            misses = 0;
            const ram = job.threads * workerRam[job.type];
            hostInfo.freeRam = Math.max(0, hostInfo.freeRam - ram);
            usedRam += ram;
            usedHosts.add(hostInfo.host);
            usedTargets.add(target.hostname);
            plannedProcesses++;

            const reservation = reservationsByTarget.get(target.hostname) ?? [];
            reservation.push({
                operation: {
                    id: `fill-${jobId++}`,
                    type: job.type,
                    threads: job.threads,
                    delay: 0,
                },
                allocations: [{ host: hostInfo.host, threads: job.threads }],
            });
            reservationsByTarget.set(target.hostname, reservation);
        }
    }

    const pids = [];
    const fillId = Date.now();
    for (const [target, reservation] of reservationsByTarget) {
        const launch = await launchReservation(
            ns,
            target,
            reservation,
            `fill-${fillId}-${target}`,
        );
        pids.push(...launch.pids);
    }
    if (pids.length > 0) {
        log(
            ns,
            `ETAPA RELLENO: ${pids.length} proceso(s) en ${usedHosts.size} host(s), ` +
            `${usedTargets.size} objetivo(s), ${ns.format.ram(usedRam)} aprovechados.`,
        );
    }
    return pids;
}

/**
 * Decide una sola accion de relleno y actualiza el estado proyectado para que
 * las siguientes asignaciones no sobre-hackeen ni sobre-preparen el objetivo.
 * @param {NS} ns
 * @param {Server & {score:number}} target
 * @param {{freeRam:number,cpuCores:number,weakenPerThread:number}} hostInfo
 * @param {Record<string,number>} workerRam
 * @param {Record<string,any>} options
 */
function planFillerJob(ns, target, hostInfo, workerRam, options) {
    const securityGap = Math.max(0, target.hackDifficulty - target.minDifficulty);
    let capacity = Math.floor(hostInfo.freeRam / workerRam.weaken);
    if (securityGap > options["security-tolerance"] && capacity > 0) {
        const effect = hostInfo.weakenPerThread ?? ns.weakenAnalyze(1, hostInfo.cpuCores);
        const threads = Math.min(capacity, Math.max(1, Math.ceil(securityGap / effect)));
        target.hackDifficulty = Math.max(target.minDifficulty, target.hackDifficulty - threads * effect);
        return { type: "weaken", threads };
    }

    const moneyRatio = target.moneyAvailable / target.moneyMax;
    capacity = Math.floor(hostInfo.freeRam / workerRam.grow);
    if (moneyRatio < options["money-threshold"] && capacity > 0) {
        const multiplier = target.moneyMax / Math.max(1, target.moneyAvailable);
        let required = Math.ceil(ns.growthAnalyze(target.hostname, multiplier, hostInfo.cpuCores));
        if (!Number.isFinite(required) || required < 1) required = capacity;
        const threads = Math.min(capacity, required);
        const progress = Math.min(1, threads / required);
        target.moneyAvailable = Math.min(
            target.moneyMax,
            Math.max(1, target.moneyAvailable) * Math.pow(multiplier, progress),
        );
        target.hackDifficulty += ns.growthAnalyzeSecurity(threads);
        return { type: "grow", threads };
    }

    capacity = Math.floor(hostInfo.freeRam / workerRam.hack);
    if (capacity < 1) return null;
    const hackPercent = ns.hackAnalyze(target.hostname);
    if (!Number.isFinite(hackPercent) || hackPercent <= 0) return null;
    const desiredFraction = Math.min(0.1, options["max-hack-fraction"]);
    const requested = Math.max(1, Math.floor(desiredFraction / hackPercent));
    const threads = Math.min(capacity, requested);
    const actualFraction = Math.min(0.99, hackPercent * threads);
    target.moneyAvailable *= 1 - actualFraction;
    target.hackDifficulty += ns.hackAnalyzeSecurity(threads, target.hostname);
    return { type: "hack", threads };
}

/**
 * Reserva un grupo completo antes de ejecutar nada. Así no se inicia medio
 * batch por falta de RAM o fragmentación.
 * @param {{host:string,freeRam:number,cpuCores:number}[]} hosts
 * @param {{id:string,type:string,threads:number,delay:number}[]} operations
 * @param {boolean} commit
 */
function reserveOperations(hosts, operations, commit = true) {
    const draft = hosts.map((host) => ({ ...host }));
    const reservations = new Map();
    const sorted = [...operations].sort((a, b) => {
        const aRam = a.threads * WORKERS[a.type].ram;
        const bRam = b.threads * WORKERS[b.type].ram;
        return bRam - aRam;
    });

    for (const operation of sorted) {
        const scriptRam = WORKERS[operation.type].ram;
        let remaining = operation.threads;
        const allocations = [];

        if (operation.type === "weaken" && Number.isFinite(operation.securityEffect)) {
            let remainingEffect = Math.max(0, operation.securityEffect);
            const efficientHosts = [...draft].sort((a, b) => {
                const aEffect = a.weakenPerThread ?? 0.05;
                const bEffect = b.weakenPerThread ?? 0.05;
                return bEffect / scriptRam - aEffect / scriptRam || b.freeRam - a.freeRam;
            });
            for (const hostInfo of efficientHosts) {
                if (remainingEffect <= 1e-12) break;
                const capacity = Math.floor(hostInfo.freeRam / scriptRam);
                if (capacity < 1) continue;
                const effectPerThread = hostInfo.weakenPerThread ?? 0.05;
                const threads = Math.min(
                    capacity,
                    Math.ceil(remainingEffect / effectPerThread),
                );
                allocations.push({ host: hostInfo.host, threads });
                hostInfo.freeRam -= threads * scriptRam;
                remainingEffect -= threads * effectPerThread;
            }
            if (remainingEffect > 1e-12) return null;
            remaining = 0;
        }

        if (operation.singleProcess) {
            const candidates = draft.filter(
                (hostInfo) => Math.floor(hostInfo.freeRam / scriptRam) >= remaining,
            );
            if (candidates.length === 0) return null;

            // Conserva home cuando sea posible y usa best-fit para reducir
            // huecos de RAM que después no admitirían ningún worker.
            const remoteCandidates = candidates.filter((hostInfo) => hostInfo.host !== HOME);
            const pool = remoteCandidates.length > 0 ? remoteCandidates : candidates;
            const hostInfo = pool.sort((a, b) => a.freeRam - b.freeRam)[0];
            allocations.push({ host: hostInfo.host, threads: remaining });
            hostInfo.freeRam -= remaining * scriptRam;
            remaining = 0;
        }

        for (const hostInfo of draft) {
            if (remaining <= 0) break;
            const threads = Math.min(
                remaining,
                Math.floor(hostInfo.freeRam / scriptRam),
            );
            if (threads < 1) continue;
            allocations.push({ host: hostInfo.host, threads });
            hostInfo.freeRam -= threads * scriptRam;
            remaining -= threads;
        }
        if (remaining > 0) return null;
        reservations.set(operation.id, { operation, allocations });
    }

    if (commit) {
        for (let index = 0; index < hosts.length; index++) {
            hosts[index].freeRam = draft[index].freeRam;
        }
    }
    return operations.map((operation) => reservations.get(operation.id));
}

/**
 * Simula el empaquetado real. A diferencia de dividir RAM total entre RAM por
 * batch, respeta que hack y grow necesitan un bloque contiguo en una máquina.
 * @param {{host:string,freeRam:number,cpuCores:number}[]} hosts
 * @param {{id:string,type:string,threads:number,delay:number,singleProcess?:boolean}[]} operations
 * @param {number} maxBatches
 * @param {number} maxProcesses
 */
function simulateBatchPacking(hosts, operations, maxBatches, maxProcesses) {
    const draft = hosts.map((host) => ({ ...host }));
    let batches = 0;
    let processes = 0;
    let firstBatchRam = 0;

    while (batches < maxBatches) {
        const ramBefore = draft.reduce((total, host) => total + host.freeRam, 0);
        const reservation = reserveOperations(draft, operations);
        if (!reservation) break;
        const batchProcesses = reservation.reduce(
            (total, item) => total + item.allocations.length,
            0,
        );
        if (processes + batchProcesses > maxProcesses) break;
        if (batches === 0) {
            const ramAfter = draft.reduce((total, host) => total + host.freeRam, 0);
            firstBatchRam = ramBefore - ramAfter;
        }
        processes += batchProcesses;
        batches++;
    }
    return { batches, processes, firstBatchRam };
}

/**
 * @param {NS} ns
 * @param {string} target
 * @param {{operation:object,allocations:{host:string,threads:number}[]}[]} reservation
 * @param {string} token
 */
async function launchReservation(ns, target, reservation, token, waveStart = null) {
    const pids = [];
    let failures = 0;
    let timingMisses = 0;
    for (const { operation, allocations } of reservation) {
        let part = 0;
        for (const allocation of allocations) {
            const baseTime = Math.max(0, operation.baseTime ?? 0);
            const landingTime = waveStart === null
                ? 0
                : waveStart + baseTime + operation.delay;
            if (waveStart !== null && landingTime - Date.now() - baseTime < 0) {
                timingMisses++;
            }
            const pid = ns.exec(
                WORKERS[operation.type].path,
                allocation.host,
                allocation.threads,
                target,
                landingTime,
                `${token}-${operation.id}-${part++}`,
            );
            if (pid === 0) {
                failures++;
                log(
                    ns,
                    `EXEC falló: ${operation.type} en ${allocation.host}, ` +
                    `${allocation.threads} hilo(s).`,
                );
                continue;
            }
            pids.push(pid);
        }
    }
    return {
        pids,
        failures,
        timingMisses,
        complete: failures === 0 && timingMisses === 0,
    };
}

/**
 * @param {{host:string,freeRam:number}[]} hosts
 * @param {number} maximum
 * @param {(threads:number)=>object[]} operationFactory
 */
function findMaxFittingThreads(hosts, maximum, operationFactory) {
    let low = 0;
    let high = Math.max(0, Math.floor(maximum));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (reserveOperations(hosts, operationFactory(middle), false)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return low;
}

/** @param {{host:string,freeRam:number}[]} hosts @param {number} scriptRam */
function getThreadCapacity(hosts, scriptRam) {
    return hosts.reduce(
        (total, host) => total + Math.floor(host.freeRam / scriptRam),
        0,
    );
}

/** @param {{host:string,freeRam:number}[]} hosts @param {number} scriptRam */
function getMaxSingleProcessThreads(hosts, scriptRam) {
    return hosts.reduce(
        (maximum, host) => Math.max(maximum, Math.floor(host.freeRam / scriptRam)),
        0,
    );
}

/**
 * Las victimas de relleno propias siempre se protegen mientras sigan activas.
 * Los procesos ajenos solo se incluyen cuando avoid-busy-targets esta activo.
 * @param {NS} ns
 * @param {Set<string>} servers
 * @param {boolean} includeExternal
 */
function findBusyTargets(ns, servers, includeExternal = true) {
    const targets = new Set();
    const knownServers = new Set(servers);
    const ownWorkers = new Set(Object.values(WORKERS).map((worker) => worker.path));

    for (const host of servers) {
        if (!ns.hasRootAccess(host)) continue;
        for (const process of ns.ps(host)) {
            if (process.pid === ns.pid) continue;
            if (ownWorkers.has(process.filename)) {
                const token = String(process.args[2] ?? "");
                const target = String(process.args[0] ?? "");
                if (token.startsWith("fill-") && knownServers.has(target)) targets.add(target);
                continue;
            }
            if (!includeExternal) continue;
            if (!/(hack|grow|weaken|batch)/i.test(process.filename)) continue;
            for (const argument of process.args) {
                const possibleTarget = String(argument);
                if (knownServers.has(possibleTarget)) targets.add(possibleTarget);
            }
        }
    }
    return targets;
}

/**
 * Espera solo al trabajo principal. Mientras sigue activo, vuelve a llenar
 * periodicamente cualquier RAM liberada por otros workers.
 * @param {NS} ns
 * @param {number[]} primaryPids
 * @param {string} primaryTarget
 * @param {Record<string,number>} workerRam
 * @param {Record<string,any>} options
 */
async function maintainUtilization(ns, primaryPids, primaryTarget, workerRam, options) {
    let nextRescan = Date.now() + options.rescan;
    let nextRefill = Date.now() + options.refill;
    while (primaryPids.some((pid) => ns.isRunning(pid))) {
        await ns.sleep(options.poll);
        const now = Date.now();

        if (options["fill-idle-ram"] && now >= nextRefill) {
            await refillIdleHosts(ns, primaryTarget, workerRam, options);
            nextRefill = Date.now() + options.refill;
        }

        if (now >= nextRescan) {
            const rooted = rootServers(ns, discoverServers(ns));
            if (rooted > 0) {
                log(ns, `ROOT durante ejecución: ${rooted} nuevo(s); se usarán inmediatamente.`);
            }
            nextRescan = Date.now() + options.rescan;
        }
    }
}

/** @param {NS} ns */
async function refillIdleHosts(ns, primaryTarget, workerRam, options) {
    const servers = discoverServers(ns);
    let hosts = getExecutionHosts(ns, servers, options["home-ram-fraction"]);
    hosts = await prepareExecutionHosts(ns, hosts);
    if (!hasWorkerCapacity(ns, hosts)) return [];

    const activeWorkers = countActiveWorkers(ns, servers);
    const processBudget = Math.max(0, options["max-processes"] - activeWorkers);
    if (processBudget < 1) return [];
    const busyTargets = findBusyTargets(
        ns,
        servers,
        options["avoid-busy-targets"],
    );
    return runIdleFill(
        ns,
        servers,
        hosts,
        workerRam,
        primaryTarget,
        busyTargets,
        options,
        processBudget,
    );
}

/** @param {NS} ns @param {Set<string>} servers */
function countActiveWorkers(ns, servers) {
    const workerPaths = new Set(Object.values(WORKERS).map((worker) => worker.path));
    let active = 0;
    for (const host of servers) {
        if (!ns.hasRootAccess(host)) continue;
        active += ns.ps(host).filter((process) => workerPaths.has(process.filename)).length;
    }
    return active;
}

/** @param {NS} ns */
function warnAboutOtherCoordinators(ns) {
    const possibleConflicts = ns.ps(HOME).filter((process) => {
        if (process.pid === ns.pid) return false;
        return /(smart-hack|distributed-hack|adaptive-hack)/i.test(process.filename);
    });
    if (possibleConflicts.length > 0) {
        log(
            ns,
            `AVISO: hay otro coordinador en home: ` +
            possibleConflicts.map((process) => `${process.filename} PID ${process.pid}`).join(", ") +
            ". Puede interferir con los batches.",
        );
    }
    return possibleConflicts.length;
}

/** @param {NS} ns @param {Record<string,any>} options */
function validateOptions(ns, options) {
    const strategies = new Set(["auto", "controller", "batch"]);
    if (!strategies.has(String(options.strategy))) {
        ns.tprint("ERROR: --strategy debe ser auto, controller o batch.");
        return false;
    }
    if (options["home-ram-fraction"] < 0 || options["home-ram-fraction"] > 1) {
        ns.tprint("ERROR: --home-ram-fraction debe estar entre 0 y 1.");
        return false;
    }
    if (options["hack-fraction"] < 0 || options["hack-fraction"] >= 0.99) {
        ns.tprint("ERROR: --hack-fraction debe ser 0 (automático) o estar entre 0 y 0.99.");
        return false;
    }
    if (options["max-hack-fraction"] <= 0 || options["max-hack-fraction"] >= 0.99) {
        ns.tprint("ERROR: --max-hack-fraction debe estar entre 0 y 0.99.");
        return false;
    }
    if (options["hack-fraction"] > options["max-hack-fraction"]) {
        ns.tprint("ERROR: --hack-fraction no puede superar --max-hack-fraction.");
        return false;
    }
    if (options["money-threshold"] <= 0 || options["money-threshold"] > 1) {
        ns.tprint("ERROR: --money-threshold debe estar entre 0 y 1.");
        return false;
    }

    const finiteOptions = [
        "security-tolerance",
        "batch-gap",
        "launch-buffer",
        "max-batches",
        "max-processes",
        "poll",
        "refill",
        "rescan",
    ];
    if (finiteOptions.some((name) => !Number.isFinite(Number(options[name])))) {
        ns.tprint("ERROR: las opciones numéricas deben contener números finitos.");
        return false;
    }

    options["security-tolerance"] = Math.max(0, Number(options["security-tolerance"]));
    options["batch-gap"] = Math.max(20, Math.floor(Number(options["batch-gap"])));
    options["launch-buffer"] = Math.max(0, Math.floor(Number(options["launch-buffer"])));
    options["max-batches"] = Math.max(1, Math.floor(Number(options["max-batches"])));
    options["max-processes"] = Math.max(4, Math.floor(Number(options["max-processes"])));
    options.poll = Math.max(50, Math.floor(Number(options.poll)));
    options.refill = Math.max(250, Math.floor(Number(options.refill)));
    options.rescan = Math.max(1000, Math.floor(Number(options.rescan)));
    return true;
}

/** @param {NS} ns @param {string} message */
function log(ns, message) {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
    ns.print(`[${time}] ${styleLogMessage(message)}`);
}

/** @param {string} message */
function styleLogMessage(message) {
    for (const [pattern, color] of LOG_STYLE_RULES) {
        if (pattern.test(message)) {
            return message.replace(pattern, `${color}$1${ANSI.reset}`);
        }
    }
    return message;
}

/** @param {NS} ns */
function printHelp(ns) {
    ns.tprint(`Uso: run ${ns.getScriptName()} [opciones]`);
    ns.tprint("  --target HOST             Fija víctima; vacío selecciona automáticamente.");
    ns.tprint("  --strategy auto           auto, controller o batch.");
    ns.tprint("  --home-ram-fraction 0.75  Parte de la RAM libre de home utilizable.");
    ns.tprint("  --hack-fraction 0         0 optimiza automáticamente la fracción.");
    ns.tprint("  --max-hack-fraction 0.8   Límite de robo por cada hack del batch.");
    ns.tprint("  --money-threshold 0.999999 Dinero exigido para considerar preparado.");
    ns.tprint("  --security-tolerance 0.0001 Margen sobre seguridad mínima.");
    ns.tprint("  --batch-gap 80            Separación HWGW en milisegundos.");
    ns.tprint("  --launch-buffer 1000      Tiempo para desplegar la oleada antes de aterrizar.");
    ns.tprint("  --max-batches 200         Protección contra exceso de procesos.");
    ns.tprint("  --max-processes 2000      Límite real de procesos por oleada.");
    ns.tprint("  --fill-idle-ram true      Usa huecos de RAM con objetivos secundarios.");
    ns.tprint("  --refill 1000             Revisa RAM ociosa cada milisegundos.");
    ns.tprint("  --avoid-busy-targets true Evita víctimas usadas por otros scripts.");
    ns.tprint("  --allow-conflicts false   Permite otros coordinadores (arriesgado).");
    ns.tprint("  --rescan 30000            Reintento de root mientras trabaja, en ms.");
}

export function autocomplete(data, args) {
    data.flags(FLAGS);
    const previous = args.at(-2);
    return previous === "--target" ? data.servers : [];
}
