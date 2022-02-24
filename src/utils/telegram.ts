import axios from "axios";

export const startServiceNotification = () => {
    axios.post(`${process.env.TELEGRAM_API_URL}/${process.env.TELEGRAM_BOT_TOKEN_SECRET}/sendMessage`, {
        chat_id: process.env.TELEGRAM_BOT_CHAT_ID,
        text: `Hello ${process.env.USER_NAME}. Notification service is starting...`,
        parse_mode: "HTML"
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    })
}

export const buySignalStrikeNotification = (symbol :string, price :number, strikeCount :number, strikeUnitPCT :number, quoteAsset :string) => {
    const printPrice = price.toLocaleString(['en-UK','en-US'],{
        maximumFractionDigits: 20,
    })

    const printStrikePCT :number = Math.floor(strikeUnitPCT * strikeCount * 100);

    axios.post(`${process.env.TELEGRAM_API_URL}/${process.env.TELEGRAM_BOT_TOKEN_SECRET}/sendMessage`, {
        chat_id: process.env.TELEGRAM_BOT_CHAT_ID,
        text: `${process.env.USER_NAME}, Checkout this trading pair => <b>${symbol.toUpperCase()}</b> currently at price <b>${printPrice} ${quoteAsset}</b>. It could be PUMPING!!! Strike count => ${strikeCount}. Percentage increase => ${printStrikePCT}%`,
        parse_mode: "HTML"
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    })
}