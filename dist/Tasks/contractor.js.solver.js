// This contract solver has the bare-minimum footprint of 1.6 GB (base) + 10 GB (ns.codingcontract.attempt)
// It does this by requiring all contract information being gathered in advance and passed in as a JSON blob argument.
/** @param {NS} ns **/
export async function main(ns) {
    if (ns.args.length < 1)
        ns.tprint('Contractor solver was incorrectly invoked without arguments.')
    var contractsDb = JSON.parse(ns.args[0]);
    for (const contractInfo of contractsDb) {
        const answer = findAnswer(contractInfo)
        if (answer != null) {
            const solvingResult = ns.codingcontract.attempt(answer, contractInfo.contract, contractInfo.hostname, { returnReward: true })
            if (solvingResult) {
                ns.toast(`Solved ${contractInfo.contract} on ${contractInfo.hostname}`, 'success');
                ns.tprint(`Solved ${contractInfo.contract} on ${contractInfo.hostname}. Reward: ${solvingResult}`)
            } else {
                ns.tprint(`Wrong answer for ${contractInfo.contract} on ${contractInfo.hostname}: ${JSON.stringify(answer)}`)
            }
        } else {
            ns.tprint(`Unable to find the answer for: ${JSON.stringify(contractInfo)}`)
        }
        await ns.sleep(10)
    }
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
    name: 'Merge Overlapping Intervals',
    solver: function (data) {
        var intervals = data.slice()
        intervals.sort(function (a, b) {
            return a[0] - b[0]
        })
        var result = []
        var start = intervals[0][0]
        var end = intervals[0][1]
        for (var _i = 0, intervals_1 = intervals; _i < intervals_1.length; _i++) {
            var interval = intervals_1[_i]
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
        for (var _i = 0, data_1 = data; _i < data_1.length; _i++) {
            var price = data_1[_i]
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
]