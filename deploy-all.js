/** @param {NS} ns */
export async function main(ns) {
    const HOME = "home";

    // Argumentos:
    // ns.args[0] = script que se ejecutará
    // ns.args[1] = servidor objetivo
    const hackScript = String(ns.args[0] ?? "").trim();
    const target = String(ns.args[1] ?? "").trim();

    if (ns.getHostname() !== HOME) {
        ns.tprint(`ERROR: ${ns.getScriptName()} debe ejecutarse desde home.`);
        return;
    }

    if (!hackScript || !target) {
        ns.tprint("ERROR: Debes indicar el script y el servidor objetivo.");
        ns.tprint(`Uso: run ${ns.getScriptName()} SCRIPT SERVIDOR`);
        ns.tprint(`Ejemplo: run ${ns.getScriptName()} hack.js n00dles`);
        return;
    }

    if (hackScript === ns.getScriptName()) {
        ns.tprint(
            `ERROR: No puedes usar ${ns.getScriptName()} como script de hackeo.`
        );
        return;
    }

    if (!ns.fileExists(hackScript, HOME)) {
        ns.tprint(`ERROR: No existe "${hackScript}" en home.`);
        return;
    }

    if (!ns.serverExists(target)) {
        ns.tprint(`ERROR: El servidor "${target}" no existe.`);
        return;
    }

    const hackScriptRam = ns.getScriptRam(hackScript, HOME);

    if (hackScriptRam <= 0) {
        ns.tprint(
            `ERROR: No se pudo calcular la RAM necesaria para "${hackScript}".`
        );
        return;
    }

    disableLogs(ns);

    /*
     * Servidores Cloud comprados por el jugador.
     */
    const cloudServers = new Set(ns.cloud.getServerNames());

    /*
     * Escaneo completo de la red sin límite de profundidad.
     * También añadimos explícitamente los servidores Cloud.
     */
    const scannedServers = scanAllServers(ns);

    const allServers = [
        ...new Set([
            ...scannedServers,
            ...cloudServers,
        ]),
    ];

    /*
     * Herramientas para abrir puertos disponibles en home.
     */
    const portOpeners = [
        {
            program: "BruteSSH.exe",
            run: (host) => ns.brutessh(host),
        },
        {
            program: "FTPCrack.exe",
            run: (host) => ns.ftpcrack(host),
        },
        {
            program: "relaySMTP.exe",
            run: (host) => ns.relaysmtp(host),
        },
        {
            program: "HTTPWorm.exe",
            run: (host) => ns.httpworm(host),
        },
        {
            program: "SQLInject.exe",
            run: (host) => ns.sqlinject(host),
        },
    ].filter((tool) => ns.fileExists(tool.program, HOME));

    const stats = {
        discovered: allServers.length,
        cloudServers: cloudServers.size,
        serversCleaned: 0,
        processesKilled: 0,
        newlyRooted: 0,
        alreadyRooted: 0,
        withoutRoot: 0,
        deployed: 0,
        totalThreads: 0,
        withoutRam: 0,
        scpErrors: 0,
        execErrors: 0,
    };

    ns.tprint("===== INICIANDO DESPLIEGUE =====");
    ns.tprint(`Script: ${hackScript}`);
    ns.tprint(`Objetivo: ${target}`);
    ns.tprint(`RAM por hilo: ${hackScriptRam.toFixed(2)} GB`);
    ns.tprint(`Servidores encontrados: ${allServers.length}`);
    ns.tprint(`Servidores Cloud: ${cloudServers.size}`);
    ns.tprint(`Herramientas de puertos: ${portOpeners.length}`);
    ns.tprint("");

    /*
     * PASO 1
     *
     * Elimina todos los scripts en todos los servidores excepto home.
     */
    for (const host of allServers) {
        if (host === HOME) continue;

        const processesBefore = ns.ps(host).length;

        if (processesBefore === 0) continue;

        const killed = ns.killall(host);

        if (killed) {
            stats.serversCleaned++;
            stats.processesKilled += processesBefore;

            ns.print(
                `LIMPIADO: ${host} — ` +
                `${processesBefore} proceso(s) terminado(s).`
            );
        }
    }

    /*
     * PASO 2
     *
     * Abre puertos y obtiene root en todos los servidores posibles.
     *
     * Los servidores Cloud comprados ya deberían tener root, por lo
     * que no se intenta usar programas de apertura contra ellos.
     */
    for (const host of allServers) {
        if (host === HOME) continue;

        let server = ns.getServer(host);

        if (server.hasAdminRights) {
            stats.alreadyRooted++;
            continue;
        }

        const isCloudServer = cloudServers.has(host);

        if (isCloudServer) {
            stats.withoutRoot++;

            ns.print(
                `AVISO: El servidor Cloud ${host} no tiene root, ` +
                `aunque normalmente debería tenerlo.`
            );

            continue;
        }

        for (const tool of portOpeners) {
            try {
                tool.run(host);
            } catch (error) {
                ns.print(
                    `ERROR ${tool.program} en ${host}: ${String(error)}`
                );
            }
        }

        const nuked = ns.nuke(host);
        server = ns.getServer(host);

        if (nuked && server.hasAdminRights) {
            stats.newlyRooted++;

            ns.print(
                `ROOT: ${host} — ` +
                `${server.openPortCount ?? 0}/` +
                `${server.numOpenPortsRequired ?? 0} puertos.`
            );
        } else {
            stats.withoutRoot++;

            ns.print(
                `SIN ROOT: ${host} — ` +
                `${server.openPortCount ?? 0}/` +
                `${server.numOpenPortsRequired ?? "?"} puertos.`
            );
        }
    }

    /*
     * Antes de desplegar comprobamos que el objetivo tenga root.
     *
     * Esto evita ejecutar cientos de scripts contra un servidor que
     * todavía no puede ser hackeado.
     */
    if (!ns.hasRootAccess(target)) {
        ns.tprint("");
        ns.tprint(
            `ERROR: No se ha podido obtener root en el objetivo "${target}".`
        );
        ns.tprint(
            `Necesita ${ns.getServerNumPortsRequired(target)} puerto(s) abiertos.`
        );
        ns.tprint(
            `Actualmente tienes ${portOpeners.length} herramienta(s) disponibles.`
        );
        return;
    }

    const targetServer = ns.getServer(target);
    const hackingLevel = ns.getHackingLevel();

    if (
        targetServer.requiredHackingSkill !== undefined &&
        hackingLevel < targetServer.requiredHackingSkill
    ) {
        ns.tprint("");
        ns.tprint(
            `AVISO: ${target} requiere hacking ` +
            `${targetServer.requiredHackingSkill}, pero tu nivel es ${hackingLevel}.`
        );
    }

    /*
     * PASO 3
     *
     * Copia el script y lo ejecuta usando toda la RAM disponible.
     */
    for (const host of allServers) {
        if (host === HOME) continue;

        let server = ns.getServer(host);

        if (!server.hasAdminRights) {
            continue;
        }

        if (server.maxRam < hackScriptRam) {
            stats.withoutRam++;

            ns.print(
                `SIN RAM: ${host} tiene ${server.maxRam.toFixed(2)} GB; ` +
                `${hackScript} necesita ${hackScriptRam.toFixed(2)} GB.`
            );

            continue;
        }

        const copied = ns.scp(hackScript, host, HOME);

        if (!copied) {
            stats.scpErrors++;

            ns.print(
                `ERROR SCP: No se pudo copiar ${hackScript} a ${host}.`
            );

            continue;
        }

        server = ns.getServer(host);

        const freeRam = Math.max(
            0,
            server.maxRam - server.ramUsed
        );

        const threads = Math.floor(
            freeRam / hackScriptRam
        );

        if (threads < 1) {
            stats.withoutRam++;

            ns.print(
                `SIN RAM LIBRE: ${host} tiene ` +
                `${freeRam.toFixed(2)} GB disponibles.`
            );

            continue;
        }

        /*
         * Equivale a:
         *
         * run hack.js -t THREADS n00dles
         *
         * El nombre del objetivo llegará al script de hackeo
         * mediante ns.args[0].
         */
        const pid = ns.exec(
            hackScript,
            host,
            threads,
            target
        );

        if (pid === 0) {
            stats.execErrors++;

            ns.print(
                `ERROR EXEC: No se pudo ejecutar ${hackScript} ` +
                `en ${host} con ${threads} hilos.`
            );

            continue;
        }

        stats.deployed++;
        stats.totalThreads += threads;

        const serverType = cloudServers.has(host)
            ? "Cloud"
            : "normal";

        ns.print(
            `OK: ${host} [${serverType}] ejecuta ${hackScript} ` +
            `contra ${target} con ${threads} hilos. PID: ${pid}`
        );
    }

    ns.tprint("");
    ns.tprint("===== DESPLIEGUE TERMINADO =====");
    ns.tprint(`Script ejecutado: ${hackScript}`);
    ns.tprint(`Objetivo común: ${target}`);
    ns.tprint(`Servidores encontrados: ${stats.discovered}`);
    ns.tprint(`Servidores Cloud: ${stats.cloudServers}`);
    ns.tprint(`Servidores limpiados: ${stats.serversCleaned}`);
    ns.tprint(`Procesos eliminados: ${stats.processesKilled}`);
    ns.tprint(`Servidores nuevos con root: ${stats.newlyRooted}`);
    ns.tprint(`Servidores que ya tenían root: ${stats.alreadyRooted}`);
    ns.tprint(`Servidores sin root: ${stats.withoutRoot}`);
    ns.tprint(`Servidores ejecutando el script: ${stats.deployed}`);
    ns.tprint(`Hilos totales desplegados: ${stats.totalThreads}`);
    ns.tprint(`Servidores sin RAM suficiente: ${stats.withoutRam}`);
    ns.tprint(`Errores de copia: ${stats.scpErrors}`);
    ns.tprint(`Errores de ejecución: ${stats.execErrors}`);
}

/**
 * Escanea toda la red mediante búsqueda en anchura.
 *
 * No tiene límite de profundidad y no devuelve duplicados.
 *
 * @param {NS} ns
 * @returns {string[]}
 */
function scanAllServers(ns) {
    const discovered = new Set(["home"]);
    const pending = ["home"];

    for (let index = 0; index < pending.length; index++) {
        const current = pending[index];

        for (const neighbour of ns.scan(current)) {
            if (discovered.has(neighbour)) continue;

            discovered.add(neighbour);
            pending.push(neighbour);
        }
    }

    return [...discovered];
}

/**
 * Desactiva logs repetitivos sin detener el script si alguno
 * no está disponible en una versión concreta.
 *
 * @param {NS} ns
 */
function disableLogs(ns) {
    const functions = [
        "scan",
        "ps",
        "killall",
        "scp",
        "exec",
        "getServer",
        "getScriptRam",
        "fileExists",
        "serverExists",
        "hasRootAccess",
        "getServerNumPortsRequired",
        "getHackingLevel",
        "brutessh",
        "ftpcrack",
        "relaysmtp",
        "httpworm",
        "sqlinject",
        "nuke",
    ];

    for (const functionName of functions) {
        try {
            ns.disableLog(functionName);
        } catch {
            // No hacemos nada si esa función no genera logs.
        }
    }
}

/**
 * Primer argumento: muestra scripts.
 * Segundo argumento: muestra servidores.
 *
 * @param {AutocompleteData} data
 * @param {ScriptArg[]} args
 */
export function autocomplete(data, args) {
    if (args.length <= 1) {
        return data.scripts;
    }

    if (args.length === 2) {
        return data.servers;
    }

    return [];
}