/** Remove sentence punctuation without turning 3.5 into 35 or -2 into 2. */
export function stripCaptionPunctuation(text:string):string {
  return text.replace(/\p{P}/gu,(mark,offset:number)=>{
    const before=text[offset-1]??"",after=text[offset+mark.length]??"";
    if(/[0-9]/.test(before)&&/[0-9]/.test(after)&&/[./:]/.test(mark)) return mark;
    if(mark==="-"&&/[0-9]/.test(after)) return mark;
    return "";
  });
}
