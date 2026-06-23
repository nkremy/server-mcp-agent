import 'dotenv/config';

const url = `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const headers = {
  "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
};


export async function markRead({id_message}){
  console.log(`*****************************************************************${id_message}`)
  console.log(`*****************************************************************${id_message}`)
  console.log(`*****************************************************************${id_message}`)
  console.log(`*****************************************************************${id_message}`)
  console.log(`*****************************************************************${id_message}`)
  console.log(`*****************************************************************${id_message}`)
  console.log(`*****************************************************************${id_message}`)
    await fetch(url,{
        method : "POST",
        headers,
        body : JSON.stringify(
            {
                "messaging_product": "whatsapp",
                "status": "read",
                "typing_indicator": {
                    "type": "text"
                },
                id_message
            }
        )
    }).then(re=>{
        console.log(`\n\n+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
        console.log(`\n\n+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
        console.log(`\n\n+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++`);
      let reponse = await re.json();
        console.log(`${reponse}`);
      
      )
      .catch(error=>{
        console.log(`[INFO] [error] echec message marquer comme lu `);
        return
    })
    console.log(`[INFO] [AGENT] message marquer comme lu `);
}
