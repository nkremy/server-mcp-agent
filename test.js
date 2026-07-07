// let mgs = {content : "talla"};
// let mgs
// console.log((mgs?.content?.length !== 0 && mgs?.content) ? "present" : "abscent")

const prefixes = {
    image: '[image]',
    audio: '[audio]'
  }

let tableau  = ['red'];
console.log(tableau);

function ajouterElementTableau(tableau,element){
    tableau.push(element)
    console.log(tableau);

}

ajouterElementTableau(tableau,"solo")
console.log(tableau);
