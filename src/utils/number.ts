export const fixDecimalPlaces = (value :number, decimalPlaces :number = 8) => {
    const pValue :number = 10 ** decimalPlaces
    return Math.round(
        ((value) + Number.EPSILON) * pValue
    ) / pValue
}