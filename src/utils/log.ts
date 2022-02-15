import * as fs from "fs";
import * as os from "os";

export const logError = (contents :string) =>{
    try {
        fs.appendFile('errors.log', `[${new Date().toString()}] : ${contents}` + os.EOL, (err) => {
            if (err) throw err;
        });
    } catch (e) {

    }
}