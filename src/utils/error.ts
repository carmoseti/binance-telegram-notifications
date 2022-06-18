export const tryCatchFinallyUtil = (fnTry = () => {
}, fnCatch = (e: Error) => {
}, fnFinally = () => {
}) => {
    try {
        fnTry()
    } catch (e) {
        fnCatch(e)
    } finally {
        fnFinally()
    }
}