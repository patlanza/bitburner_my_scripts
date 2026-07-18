export async function main(ns) {
    const flags = ns.flags([
        ['refreshrate', 200],
        ['help', false],
    ])
    if (flags._.length === 0 || flags.help) {
        ns.tprint("This script helps visualize the money and security of a server.");
        ns.tprint(`USAGE: run ${ns.getScriptName()} SERVER_NAME`);
        ns.tprint("Example:");
        ns.tprint(`> run ${ns.getScriptName()} n00dles`)
        return;
    }
    const server = String(flags._[0]);
    if (!ns.serverExists(server)) {
        ns.tprint(`ERROR: El servidor "${server}" no existe.`);
        return;
    }

    const serverInfo = ns.getServer(server);
    if ((serverInfo.moneyMax ?? 0) <= 0) {
        ns.tprint(`ERROR: "${server}" no es un servidor hackeable con dinero.`);
        return;
    }

    ns.ui.openTail();
    ns.disableLog('ALL');
    while (true) {
        const money = ns.getServerMoneyAvailable(server);
        const safeMoney = Math.max(money, 1);
        const maxMoney = ns.getServerMaxMoney(server);
        const minSec = ns.getServerMinSecurityLevel(server);
        const sec = ns.getServerSecurityLevel(server);
        ns.clearLog();
        ns.print(`${server}:`);
        ns.print(` $_______: $${ns.format.number(money, 3)} / $${ns.format.number(maxMoney, 3)} (${ns.format.percent(money / maxMoney, 2)})`);
        ns.print(` security: +${(sec - minSec).toFixed(2)}`);
        ns.print(` hack____: ${ns.format.time(ns.getHackTime(server))} (t=${Math.ceil(ns.hackAnalyzeThreads(server, safeMoney))})`);
        ns.print(` grow____: ${ns.format.time(ns.getGrowTime(server))} (t=${Math.ceil(ns.growthAnalyze(server, maxMoney / safeMoney))})`);
        ns.print(` weaken__: ${ns.format.time(ns.getWeakenTime(server))} (t=${Math.ceil((sec - minSec) * 20)})`);
        await ns.sleep(flags.refreshrate);
    }
}

export function autocomplete(data, args) {
    return data.servers;
}
