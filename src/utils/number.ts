export const fixDecimalPlaces = (value: number, decimalPlaces: number = 2) :number => {
    return Number(value.toFixed(decimalPlaces))
}

export const getDecimalPlacesFromIncrement = (floatIncrementNumber: number): number => {
    return Math.abs(Math.log10(floatIncrementNumber))
}