let doc = eval("document"),
    f = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "w0r1d_d43m0n"],
    css = `<style id="scanCSS">
        .sc {white-space:pre; color:#ccc; font:14px monospace; line-height: 16px; }
        .sc .s {color:#080;cursor:pointer;text-decoration:underline}
        .sc .f {color:#088}
        .sc .r {color:#6f3}
        .sc .r.f {color:#0ff}
        .sc .r::before {color:#6f3}
        .sc .hack {display:inline-block; font:12px monospace}
        .sc .red {color:red;}
        .sc .green {color:green;}
    </style>`,
    tprint = html => doc.getElementById("terminal").insertAdjacentHTML('beforeend', `<li>${html}</li>`);
/** @param {NS} ns **/
export let main = ns => {
    let tIn = doc.getElementById("terminal-input"),
        tEv = tIn[Object.keys(tIn)[1]];
    doc.head.insertAdjacentHTML('beforeend', doc.getElementById("scanCSS") ? "" : css);
    let s = ["home"],
        p = [""],
        r = { home: "home" },
        myHack = ns.getHackingLevel(),
        fName = x => {
            let reqHack = ns.getServerRequiredHackingLevel(x);
            return `<a class="s${f.includes(x) ? " f" : ""}${ns.hasRootAccess(x) ? " r" : ""}">${x}</a>` +
                ` <span class="hack ${(reqHack <= myHack ? 'green' : 'red')}">(${reqHack})</span>` +
                `${' @'.repeat(ns.ls(x, ".cct").length)}`;
        };
    let tcommand = x => {
        tIn.value = x;
        tEv.onChange({ target: tIn });
        tEv.onKeyDown({ keyCode: "13", preventDefault: () => 0 });
    };

    let addSc = (x = s[0], p1 = ["\n"], o = p1.join("") + fName(x)) => {
        for (let i = 0; i < s.length; i++) {
            if (p[i] != x) continue;
            let p2 = p1.slice();
            p2[p2.length - 1] = p2[p2.push(p.slice(i + 1).includes(p[i]) ? "├╴" : "└╴") - 2].replace("├╴", "│ ").replace("└╴", "  ");
            o += addSc(s[i], p2);
        }
        return o;
    };
    for (let i = 0, j; i < s.length; i++)
        for (j of ns.scan(s[i]))
            if (!s.includes(j)) s.push(j), p.push(s[i]), r[j] = r[s[i]] + ";connect " + j;
    tprint(`<div class="sc new">${addSc()}</div>`);
    doc.querySelectorAll(".sc.new .s").forEach(q => q.addEventListener('click', tcommand.bind(null, r[q.childNodes[0].nodeValue])));
    doc.querySelector(".sc.new").classList.remove("new");
};