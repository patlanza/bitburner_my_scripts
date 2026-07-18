export async function main(ns) {
    const args = ns.flags([["help", false]]);
    const server = String(args._[0] ?? "");
    if (args.help || !server) {
        ns.tprint("This script does a more detailed analysis of a server.");
        ns.tprint(`Usage: run ${ns.getScriptName()} SERVER`);
        ns.tprint("Example:");
        ns.tprint(`> run ${ns.getScriptName()} n00dles`);
        return;
    }
    if (!ns.serverExists(server)) {
        ns.tprint(`ERROR: El servidor "${server}" no existe.`);
        return;
    }

    const serverInfo = ns.getServer(server);
    if ((serverInfo.moneyMax ?? 0) <= 0) {
        ns.tprint(`ERROR: "${server}" no es un servidor hackeable con dinero.`);
        return;
    }

    const maxRam = ns.getServerMaxRam(server);
    const usedRam = ns.getServerUsedRam(server);
    const money = ns.getServerMoneyAvailable(server);
    const maxMoney = ns.getServerMaxMoney(server);
    const minSec = ns.getServerMinSecurityLevel(server);
    const sec = ns.getServerSecurityLevel(server);
    ns.tprint(`

${server}:
    RAM        : ${ns.format.ram(usedRam)} / ${ns.format.ram(maxRam)} (${maxRam > 0 ? ns.format.percent(usedRam / maxRam, 2) : "0%"})
    $          : $${ns.format.number(money, 3)} / $${ns.format.number(maxMoney, 3)} (${ns.format.percent(money / maxMoney, 2)})
    security   : ${minSec.toFixed(2)} / ${sec.toFixed(2)}
    growth     : ${ns.getServerGrowth(server)}
    hack time  : ${ns.format.time(ns.getHackTime(server))}
    grow time  : ${ns.format.time(ns.getGrowTime(server))}
    weaken time: ${ns.format.time(ns.getWeakenTime(server))}
    grow x2    : ${(ns.growthAnalyze(server, 2)).toFixed(2)} threads
    grow x3    : ${(ns.growthAnalyze(server, 3)).toFixed(2)} threads
    grow x4    : ${(ns.growthAnalyze(server, 4)).toFixed(2)} threads
    hack 10%   : ${(.10 / ns.hackAnalyze(server)).toFixed(2)} threads
    hack 25%   : ${(.25 / ns.hackAnalyze(server)).toFixed(2)} threads
    hack 50%   : ${(.50 / ns.hackAnalyze(server)).toFixed(2)} threads
    hackChance : ${(ns.hackAnalyzeChance(server) * 100).toFixed(2)}%
`);
}
