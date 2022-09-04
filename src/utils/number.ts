export const fixDecimalPlaces = (value: number, decimalPlaces: number = 2) :number => {
    return Number(value.toFixed(decimalPlaces))
}