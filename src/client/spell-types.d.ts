declare module "nspell" {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string): NSpell;
  }
  export default function nspell(aff: string, dic: string): NSpell;
}
declare module "*.aff" {
  const text: string;
  export default text;
}
declare module "*.dic" {
  const text: string;
  export default text;
}
