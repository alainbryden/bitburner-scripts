const fUnsolvedContracts = '/Temp/unsolved-contracts.txt'; // A global, persistent array of contracts we couldn't solve, so we don't repeatedly log about them.

//Silly human, you can't import a typescript module into a javascript 
//import { codingContractTypesMetadata } from 'https://raw.githubusercontent.com/danielyxie/bitburner/master/src/data/codingcontracttypes.ts'

// This contract solver has the bare-minimum footprint of 1.6 GB (base) + 10 GB (ns.codingcontract.attempt)
// It does this by requiring all contract information being gathered in advance and passed in as a JSON blob argument.
// TODO: Pull solvers directly from https://raw.githubusercontent.com/danielyxie/bitburner/master/src/data/codingcontracttypes.ts
/** @param {NS} ns **/
export async function main(ns) {
    if (ns.args.length < 1)
        ns.tprint('Contractor solver was incorrectly invoked without arguments.')
    var contractsDb = JSON.parse(ns.args[0]);
    const fContents = ns.read(fUnsolvedContracts);
    const notified = fContents ? JSON.parse(fContents) : [];
    for (const contractInfo of contractsDb) {
        const answer = findAnswer(contractInfo)
        let notice = null;
        if (answer != null) {
            const solvingResult = ns.codingcontract.attempt(answer, contractInfo.contract, contractInfo.hostname, { returnReward: true })
            if (solvingResult) {
                ns.toast(`Solved ${contractInfo.contract} on ${contractInfo.hostname}`, 'success');
                ns.tprint(`Solved ${contractInfo.contract} on ${contractInfo.hostname}. Reward: ${solvingResult}`)
            } else {
                notice = `ERROR: Wrong answer for ${contractInfo.contract} on ${contractInfo.hostname}: ${JSON.stringify(answer)}`;
            }
        } else {
            notice = `WARNING: No solver available for contract type "${contractInfo.type}"\nFull info: ${JSON.stringify(contractInfo)})`;
        }
        if (notice) {
            if (!notified.includes(contractInfo.contract)) {
                ns.tprint(notice)
                ns.toast(notice, 'warning');
                notified.push(contractInfo.contract)
            }
            ns.print(notice);
        }
        await ns.sleep(10)
    }
    // Keep tabs of failed contracts
    if (notified.length > 0)
        await ns.write(fUnsolvedContracts, JSON.stringify(notified), "w");
}

function findAnswer(contract) {
    const codingContractSolution = codingContractTypesMetadata.find((codingContractTypeMetadata) => codingContractTypeMetadata.name === contract.type)
    return codingContractSolution ? codingContractSolution.solver(contract.data) : null;
}

function convert2DArrayToString(arr) {
    var components = []
    arr.forEach(function (e) {
        var s = e.toString()
        s = ['[', s, ']'].join('')
        components.push(s)
    })
    return components.join(',').replace(/\s/g, '')
}

// Based on https://github.com/danielyxie/bitburner/blob/master/src/data/codingcontracttypes.ts
const codingContractTypesMetadata = [{
    name: 'Find Largest Prime Factor',
    solver: function (data) {
        var fac = 2
        var n = data
        while (n > (fac - 1) * (fac - 1)) {
            while (n % fac === 0) {
                n = Math.round(n / fac)
            }
            ++fac
        }
        return n === 1 ? fac - 1 : n
    },
},
{
    name: 'Subarray with Maximum Sum',
    solver: function (data) {
        var nums = data.slice()
        for (var i = 1; i < nums.length; i++) {
            nums[i] = Math.max(nums[i], nums[i] + nums[i - 1])
        }
        return Math.max.apply(Math, nums)
    },
},
{
    name: 'Total Ways to Sum',
    solver: function (data) {
        var ways = [1]
        ways.length = data + 1
        ways.fill(0, 1)
        for (var i = 1; i < data; ++i) {
            for (var j = i; j <= data; ++j) {
                ways[j] += ways[j - i]
            }
        }
        return ways[data]
    },
},
{
    name: 'Total Ways to Sum II',
    solver: function (data) {
        const n = data[0];
        const s = data[1];
        const ways = [1];
        ways.length = n + 1;
        ways.fill(0, 1);
        for (let i = 0; i < s.length; i++) {
            for (let j = s[i]; j <= n; j++) {
                ways[j] += ways[j - s[i]];
            }
        }
        return ways[n];
    },
},
{
    name: 'Spiralize Matrix',
    solver: function (data, ans) {
        var spiral = []
        var m = data.length
        var n = data[0].length
        var u = 0
        var d = m - 1
        var l = 0
        var r = n - 1
        var k = 0
        while (true) {
            // Up
            for (var col = l; col <= r; col++) {
                spiral[k] = data[u][col]
                ++k
            }
            if (++u > d) {
                break
            }
            // Right
            for (var row = u; row <= d; row++) {
                spiral[k] = data[row][r]
                ++k
            }
            if (--r < l) {
                break
            }
            // Down
            for (var col = r; col >= l; col--) {
                spiral[k] = data[d][col]
                ++k
            }
            if (--d < u) {
                break
            }
            // Left
            for (var row = d; row >= u; row--) {
                spiral[k] = data[row][l]
                ++k
            }
            if (++l > r) {
                break
            }
        }

        return spiral
    },
},
{
    name: 'Array Jumping Game',
    solver: function (data) {
        var n = data.length
        var i = 0
        for (var reach = 0; i < n && i <= reach; ++i) {
            reach = Math.max(i + data[i], reach)
        }
        var solution = i === n
        return solution ? 1 : 0
    },
},
{
    name: 'Array Jumping Game II',
    solver: function (data) {
        const n = data.length;
        let reach = 0;
        let jumps = 0;
        let lastJump = -1;
        while (reach < n - 1) {
            let jumpedFrom = -1;
            for (let i = reach; i > lastJump; i--) {
                if (i + data[i] > reach) {
                    reach = i + data[i];
                    jumpedFrom = i;
                }
            }
            if (jumpedFrom === -1) {
                jumps = 0;
                break;
            }
            lastJump = jumpedFrom;
            jumps++;
        }
        return jumps;
    },
},
{
    name: 'Merge Overlapping Intervals',
    solver: function (data) {
        var intervals = data.slice()
        intervals.sort(function (a, b) {
            return a[0] - b[0]
        })
        var result = []
        var start = intervals[0][0]
        var end = intervals[0][1]
        for (var i = 0, intervals_1 = intervals; i < intervals_1.length; i++) {
            var interval = intervals_1[i]
            if (interval[0] <= end) {
                end = Math.max(end, interval[1])
            } else {
                result.push([start, end])
                start = interval[0]
                end = interval[1]
            }
        }
        result.push([start, end])
        var sanitizedResult = convert2DArrayToString(result)
        return sanitizedResult
    },
},
{
    name: 'Generate IP Addresses',
    solver: function (data, ans) {
        var ret = []
        for (var a = 1; a <= 3; ++a) {
            for (var b = 1; b <= 3; ++b) {
                for (var c = 1; c <= 3; ++c) {
                    for (var d = 1; d <= 3; ++d) {
                        if (a + b + c + d === data.length) {
                            var A = parseInt(data.substring(0, a), 10)
                            var B = parseInt(data.substring(a, a + b), 10)
                            var C = parseInt(data.substring(a + b, a + b + c), 10)
                            var D = parseInt(data.substring(a + b + c, a + b + c + d), 10)
                            if (A <= 255 && B <= 255 && C <= 255 && D <= 255) {
                                var ip = [A.toString(), '.', B.toString(), '.', C.toString(), '.', D.toString()].join('')
                                if (ip.length === data.length + 3) {
                                    ret.push(ip)
                                }
                            }
                        }
                    }
                }
            }
        }
        return ret
    },
},
{
    name: 'Algorithmic Stock Trader I',
    solver: function (data) {
        var maxCur = 0
        var maxSoFar = 0
        for (var i = 1; i < data.length; ++i) {
            maxCur = Math.max(0, (maxCur += data[i] - data[i - 1]))
            maxSoFar = Math.max(maxCur, maxSoFar)
        }
        return maxSoFar.toString()
    },
},
{
    name: 'Algorithmic Stock Trader II',
    solver: function (data) {
        var profit = 0
        for (var p = 1; p < data.length; ++p) {
            profit += Math.max(data[p] - data[p - 1], 0)
        }
        return profit.toString()
    },
},
{
    name: 'Algorithmic Stock Trader III',
    solver: function (data) {
        var hold1 = Number.MIN_SAFE_INTEGER
        var hold2 = Number.MIN_SAFE_INTEGER
        var release1 = 0
        var release2 = 0
        for (var i = 0, data_1 = data; i < data_1.length; i++) {
            var price = data_1[i]
            release2 = Math.max(release2, hold2 + price)
            hold2 = Math.max(hold2, release1 - price)
            release1 = Math.max(release1, hold1 + price)
            hold1 = Math.max(hold1, price * -1)
        }
        return release2.toString()
    },
},
{
    name: 'Algorithmic Stock Trader IV',
    solver: function (data) {
        var k = data[0]
        var prices = data[1]
        var len = prices.length
        if (len < 2) {
            return 0
        }
        if (k > len / 2) {
            var res = 0
            for (var i = 1; i < len; ++i) {
                res += Math.max(prices[i] - prices[i - 1], 0)
            }
            return res
        }
        var hold = []
        var rele = []
        hold.length = k + 1
        rele.length = k + 1
        for (var i = 0; i <= k; ++i) {
            hold[i] = Number.MIN_SAFE_INTEGER
            rele[i] = 0
        }
        var cur
        for (var i = 0; i < len; ++i) {
            cur = prices[i]
            for (var j = k; j > 0; --j) {
                rele[j] = Math.max(rele[j], hold[j] + cur)
                hold[j] = Math.max(hold[j], rele[j - 1] - cur)
            }
        }
        return rele[k]
    },
},
{
    name: 'Minimum Path Sum in a Triangle',
    solver: function (data) {
        var n = data.length
        var dp = data[n - 1].slice()
        for (var i = n - 2; i > -1; --i) {
            for (var j = 0; j < data[i].length; ++j) {
                dp[j] = Math.min(dp[j], dp[j + 1]) + data[i][j]
            }
        }
        return dp[0]
    },
},
{
    name: 'Unique Paths in a Grid I',
    solver: function (data) {
        var n = data[0] // Number of rows
        var m = data[1] // Number of columns
        var currentRow = []
        currentRow.length = n
        for (var i = 0; i < n; i++) {
            currentRow[i] = 1
        }
        for (var row = 1; row < m; row++) {
            for (var i = 1; i < n; i++) {
                currentRow[i] += currentRow[i - 1]
            }
        }
        return currentRow[n - 1]
    },
},
{
    name: 'Unique Paths in a Grid II',
    solver: function (data) {
        var obstacleGrid = []
        obstacleGrid.length = data.length
        for (var i = 0; i < obstacleGrid.length; ++i) {
            obstacleGrid[i] = data[i].slice()
        }
        for (var i = 0; i < obstacleGrid.length; i++) {
            for (var j = 0; j < obstacleGrid[0].length; j++) {
                if (obstacleGrid[i][j] == 1) {
                    obstacleGrid[i][j] = 0
                } else if (i == 0 && j == 0) {
                    obstacleGrid[0][0] = 1
                } else {
                    obstacleGrid[i][j] = (i > 0 ? obstacleGrid[i - 1][j] : 0) + (j > 0 ? obstacleGrid[i][j - 1] : 0)
                }
            }
        }
        return obstacleGrid[obstacleGrid.length - 1][obstacleGrid[0].length - 1]
    },
},
{
    name: 'Sanitize Parentheses in Expression',
    solver: function (data) {
        var left = 0
        var right = 0
        var res = []
        for (var i = 0; i < data.length; ++i) {
            if (data[i] === '(') {
                ++left
            } else if (data[i] === ')') {
                left > 0 ? --left : ++right
            }
        }

        function dfs(pair, index, left, right, s, solution, res) {
            if (s.length === index) {
                if (left === 0 && right === 0 && pair === 0) {
                    for (var i = 0; i < res.length; i++) {
                        if (res[i] === solution) {
                            return
                        }
                    }
                    res.push(solution)
                }
                return
            }
            if (s[index] === '(') {
                if (left > 0) {
                    dfs(pair, index + 1, left - 1, right, s, solution, res)
                }
                dfs(pair + 1, index + 1, left, right, s, solution + s[index], res)
            } else if (s[index] === ')') {
                if (right > 0) dfs(pair, index + 1, left, right - 1, s, solution, res)
                if (pair > 0) dfs(pair - 1, index + 1, left, right, s, solution + s[index], res)
            } else {
                dfs(pair, index + 1, left, right, s, solution + s[index], res)
            }
        }
        dfs(0, 0, left, right, data, '', res)

        return res
    },
},
{
    name: 'Find All Valid Math Expressions',
    solver: function (data) {
        var num = data[0]
        var target = data[1]

        function helper(res, path, num, target, pos, evaluated, multed) {
            if (pos === num.length) {
                if (target === evaluated) {
                    res.push(path)
                }
                return
            }
            for (var i = pos; i < num.length; ++i) {
                if (i != pos && num[pos] == '0') {
                    break
                }
                var cur = parseInt(num.substring(pos, i + 1))
                if (pos === 0) {
                    helper(res, path + cur, num, target, i + 1, cur, cur)
                } else {
                    helper(res, path + '+' + cur, num, target, i + 1, evaluated + cur, cur)
                    helper(res, path + '-' + cur, num, target, i + 1, evaluated - cur, -cur)
                    helper(res, path + '*' + cur, num, target, i + 1, evaluated - multed + multed * cur, multed * cur)
                }
            }
        }

        if (num == null || num.length === 0) {
            return []
        }
        var result = []
        helper(result, '', num, target, 0, 0, 0)
        return result
    },
},
{
    name: 'HammingCodes: Integer to encoded Binary',
    solver: function (value) {
        // Calculates the needed amount of parityBits 'without' the "overall"-Parity
        HammingSumOfParity = lengthOfDBits => lengthOfDBits == 0 ? 0 : lengthOfDBits < 3 ? lengthOfDBits + 1 :
            Math.ceil(Math.log2(lengthOfDBits * 2)) <= Math.ceil(Math.log2(1 + lengthOfDBits + Math.ceil(Math.log2(lengthOfDBits)))) ?
                Math.ceil(Math.log2(lengthOfDBits) + 1) : Math.ceil(Math.log2(lengthOfDBits));
        const data = value.toString(2).split(""); // first, change into binary string, then create array with 1 bit per index
        const sumParity = HammingSumOfParity(data.length); // get the sum of needed parity bits (for later use in encoding)
        const count = (arr, val) => arr.reduce((a, v) => (v === val ? a + 1 : a), 0);
        // function count for specific entries in the array, for later use
        const build = ["x", "x", ...data.splice(0, 1)]; // init the "pre-build"
        for (let i = 2; i < sumParity; i++)
            build.push("x", ...data.splice(0, Math.pow(2, i) - 1)); // add new paritybits and the corresponding data bits (pre-building array)
        // Get the index numbers where the parity bits "x" are placed
        const parityBits = build.map((e, i) => [e, i]).filter(([e, _]) => e == "x").map(([_, i]) => i);
        for (const index of parityBits) {
            const tempcount = index + 1; // set the "stepsize" for the parityBit
            const temparray = []; // temporary array to store the extracted bits
            const tempdata = [...build]; // only work with a copy of the build
            while (tempdata[index] !== undefined) {
                // as long as there are bits on the starting index, do "cut"
                const temp = tempdata.splice(index, tempcount * 2); // cut stepsize*2 bits, then...
                temparray.push(...temp.splice(0, tempcount)); // ... cut the result again and keep the first half
            }
            temparray.splice(0, 1); // remove first bit, which is the parity one
            build[index] = (count(temparray, "1") % 2).toString(); // count with remainder of 2 and"toString" to store the parityBit
        } // parity done, now the "overall"-parity is set
        build.unshift((count(build, "1") % 2).toString()); // has to be done as last element
        return build.join(""); // return the build as string
    },
},
{
    name: 'HammingCodes: Encoded Binary to Integer',
    solver: function (data) {
        //check for altered bit and decode
        const build = data.split(""); // ye, an array for working, again
        const testArray = []; //for the "truthtable". if any is false, the data has an altered bit, will check for and fix it
        const sumParity = Math.ceil(Math.log2(data.length)); // sum of parity for later use
        const count = (arr, val) => arr.reduce((a, v) => (v === val ? a + 1 : a), 0);
        // the count.... again ;)
        let overallParity = build.splice(0, 1).join(""); // store first index, for checking in next step and fix the build properly later on
        testArray.push(overallParity == (count(build, "1") % 2).toString() ? true : false); // first check with the overall parity bit
        for (let i = 0; i < sumParity; i++) {
            // for the rest of the remaining parity bits we also "check"
            const tempIndex = Math.pow(2, i) - 1; // get the parityBits Index
            const tempStep = tempIndex + 1; // set the stepsize
            const tempData = [...build]; // get a "copy" of the build-data for working
            const tempArray = []; // init empty array for "testing"
            while (tempData[tempIndex] != undefined) {
                // extract from the copied data until the "starting" index is undefined
                const temp = [...tempData.splice(tempIndex, tempStep * 2)]; // extract 2*stepsize
                tempArray.push(...temp.splice(0, tempStep)); // and cut again for keeping first half
            }
            const tempParity = tempArray.shift(); // and again save the first index separated for checking with the rest of the data
            testArray.push(tempParity == (count(tempArray, "1") % 2).toString() ? true : false);
            // is the tempParity the calculated data? push answer into the 'truthtable'
        }
        let fixIndex = 0; // init the "fixing" index and start with 0
        for (let i = 1; i < sumParity + 1; i++) {
            // simple binary adding for every boolean in the testArray, starting from 2nd index of it
            fixIndex += testArray[i] ? 0 : Math.pow(2, i) / 2;
        }
        build.unshift(overallParity); // now we need the "overall" parity back in it's place
        // try fix the actual encoded binary string if there is an error
        if (fixIndex > 0 && testArray[0] == false) { // if the overall is false and the sum of calculated values is greater equal 0, fix the corresponding hamming-bit           
            build[fixIndex] = build[fixIndex] == "0" ? "1" : "0";
        } else if (testArray[0] == false) { // otherwise, if the the overallparity is the only wrong, fix that one           
            overallParity = overallParity == "0" ? "1" : "0";
        } else if (testArray[0] == true && testArray.some((truth) => truth == false)) {
            return 0; // ERROR: There's some strange going on... 2 bits are altered? How? This should not happen
        }
        // oof.. halfway through... we fixed an possible altered bit, now "extract" the parity-bits from the build
        for (let i = sumParity; i >= 0; i--) {
            // start from the last parity down the 2nd index one
            build.splice(Math.pow(2, i), 1);
        }
        build.splice(0, 1); // remove the overall parity bit and we have our binary value
        return parseInt(build.join(""), 2); // parse the integer with redux 2 and we're done!
    },
},
]