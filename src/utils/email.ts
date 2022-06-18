import nodemailer from "nodemailer"
import {logError} from "./log"

export const sendApeInEmail = (symbol: string, percentageChange: number) => {
    const transporter = nodemailer.createTransport({
        // @ts-ignore
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        secure: true,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
        },
    })

    transporter.sendMail({
        from: `"${process.env.EMAIL_SENDER_NAME}" <${process.env.EMAIL_USER}>`,
        to: `"${process.env.EMAIL_RECEIVER_NAME}" <${process.env.EMAIL_RECEIVER_ADDRESS}>`,
        cc: `${process.env.EMAIL_RECEIVER_CC}`,
        subject: `BINANCE APE-IN NOTIFICATION - ${symbol.toUpperCase()}`,
        text: `Hello ${process.env.USER_NAME}, Checkout ${symbol} currently with percentage change: ${percentageChange}% in the last 24hrs`,
        html: `Hello ${process.env.USER_NAME}, <p>Checkout <b>${symbol}</b> currently with percentage change: <b>${percentageChange}%</b> in the last 24hrs</p>`
        // tslint:disable-next-line:no-empty
    }).then((value) => {
        transporter.close()
    }, (error: Error) => {
        sendApeInEmail(symbol, percentageChange)
        logError(`Email.transporter() ${error}`)
    })
}