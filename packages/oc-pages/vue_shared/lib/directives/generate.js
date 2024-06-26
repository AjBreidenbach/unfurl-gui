function asNumber(n) {
    if(typeof n == 'string') {
        return n.charCodeAt(0)
    }

    return n
}

function rangeLength(range) {
    return asNumber(range[1]) - asNumber(range[0]) + 1

}
function totalRangesLength(ranges) {
    let result = 0
    for(const range of ranges) {
        result += rangeLength(range)
    }
    return result
}

function getRandomCode(ranges) {
    const r = Math.floor(Math.random() * totalRangesLength(ranges))
    let lastAccumulated = 0
    for(let i = 0; i < ranges.length; i++) {
        const accumulated = totalRangesLength(ranges.slice(0, i + 1))
        if(r < accumulated) {
            const indexInRange = r - lastAccumulated
            return asNumber(ranges[i][0]) + indexInRange
        }
        lastAccumulated = accumulated
    }
}

export default function resolve(params) {
    let len = params.length || params.len
    if(params.preset == 'password') {
        len = len || 15
        let password = resolve({ranges: [[48, 57], [65, 90], [97, 122]], len: len})
        if(!password.match(/\d/)) {
            const num = resolve({preset: 'number', len: 1})
            const index = Math.floor(Math.random() * len)
            password = password.slice(0, index) + num + password.slice(index+1)
        }
        return password
    } else if (params.preset == 'number') {
        return resolve({ranges: [[48, 57]], len: len || 1})
    }
    const {ranges} = params
    const codes = Array.from(Array(len), getRandomCode.bind(null, ranges))

    return String.fromCodePoint.apply(null, codes)
}
