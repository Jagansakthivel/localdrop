export interface OfferReservation {offerId:string;transferId:string;generation:number;name:string;size:number;mime:string;deadline:number;accepted:boolean}
/** One incoming offer per direction; expire independently even if sender is lost. */
export class OfferReservations {
  private currentOffer:OfferReservation|null=null;
  get current(){return this.currentOffer;}
  reserve(offer:OfferReservation,now=performance.now()){this.expire(now);if(this.currentOffer||offer.deadline<=now)return false;this.currentOffer={...offer};return true;}
  expire(now=performance.now()){if(this.currentOffer&&this.currentOffer.deadline<=now){const old=this.currentOffer;this.currentOffer=null;return old;}return null;}
  busy(now=performance.now()){this.expire(now);return this.currentOffer!==null;}
  accept(offerId:string,generation:number,now=performance.now()){this.expire(now);const o=this.currentOffer;if(!o||o.offerId!==offerId||o.generation!==generation)return false;o.accepted=true;return true;}
  consume(transferId:string,generation:number,name:string,size:number,mime:string,now=performance.now()){this.expire(now);const o=this.currentOffer;if(!o||!o.accepted||o.transferId!==transferId||o.generation!==generation||o.name!==name||o.size!==size||o.mime!==mime)return false;this.currentOffer=null;return true;}
  clear(offerId:string,transferId:string,generation:number){const o=this.currentOffer;if(!o||o.offerId!==offerId||o.transferId!==transferId||o.generation!==generation)return false;this.currentOffer=null;return true;}
  reset(){this.currentOffer=null;}
}
