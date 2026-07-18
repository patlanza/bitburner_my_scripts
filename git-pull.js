/** @param {NS} ns */
export async function main(ns) {
    const owner = "patlanza";
    const repository = "bitburner_my_scripts";
    const branch = "master";
    const extensions = [".js", ".jsx", ".ts", ".tsx", ".txt", ".json"];

    ns.disableLog("wget");

    const treeUrl =
        `https://api.github.com/repos/${owner}/${repository}` +
        `/git/trees/${branch}?recursive=1`;

    let response;
    try {
        response = await fetch(treeUrl, { cache: "no-store" });
    } catch (error) {
        ns.tprint(`ERROR: No se pudo conectar con GitHub: ${String(error)}`);
        return;
    }

    if (!response.ok) {
        ns.tprint(
            `ERROR: GitHub respondio ${response.status} ${response.statusText}.`,
        );
        return;
    }

    const data = await response.json();
    const files = data.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path)
        .filter((path) => extensions.some((extension) => path.endsWith(extension)))
        // Un script en ejecucion no puede sobrescribirse a si mismo.
        .filter((path) => path !== ns.getScriptName());

    if (files.length === 0) {
        ns.tprint("WARNING: No se encontraron archivos compatibles.");
        return;
    }

    let updated = 0;
    const failed = [];

    for (const path of files) {
        const encodedPath = path.split("/").map(encodeURIComponent).join("/");
        const rawUrl =
            `https://raw.githubusercontent.com/${owner}/${repository}/` +
            `${branch}/${encodedPath}?t=${Date.now()}`;

        if (await ns.wget(rawUrl, path, "home")) {
            updated++;
            ns.tprint(`OK: ${path}`);
        } else {
            failed.push(path);
            ns.tprint(`ERROR: No se pudo actualizar ${path}`);
        }
    }

    ns.tprint(`Actualizacion terminada: ${updated}/${files.length} archivos.`);
    if (failed.length > 0) {
        ns.tprint(
            "No actualizados (pueden estar ejecutandose): " + failed.join(", "),
        );
    }
}
