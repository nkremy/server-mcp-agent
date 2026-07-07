import {getOuCreerSessionActive} from "./src/outils-supabase.js"

try {
    
    let resultat = await getOuCreerSessionActive({phone : '237686579096'});
    console.dir(resultat , {depth : null})
} catch (error) {
    console.log(error.name)
    console.log(error.message)
}