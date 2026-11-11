// TubeCorporate feed / campaign URL. Paste a new value between the quotes below
// and commit; the build decides how to use it. This is public information, not a
// secret.
//
// Two shapes are accepted:
//   1. A single video embed page, e.g.
//      https://desi-porntube.com/embed/762647/?source=1849513610
//      (or https://hdzog.com/embed/2168747?source=1849513610)
//      It is rendered as one sponsored iframe.
//   2. A campaign CSV feed (the "feeds" link in the TubeCorporate dashboard),
//      e.g. https://desiporn.tube/admin/feeds/embed/?...&feed_format=csv&...
//      The build reads it and renders a lazy grid of the sponsored videos.
//
// The campaign `source` parameter is added automatically when the pasted URL
// does not contain one. Only https URLs on the accepted partner hosts are
// allowed, so a mistyped value fails the build instead of shipping.
export const PARTNER_EMBED_URL = "https://desiporn.tube/admin/feeds/embed/?categories=AI%20Porn%2CAmateur%2CAnal%2CBBW%2CBDSM%2CBangladeshi%2CBig%20Ass%2CBig%20Cock%2CBig%20Nipples%2CBig%20Tits%2CBlonde%2CBlowjob%2CBondage%2CBrunette%2CCar%2CChanging%20Room%2CChubby%2CClose-up%2CCompilation%2CCouple%2CCreampie%2CCuckold%2CCum%20In%20Mouth%2CCunnilingus%2CDeepthroat%2CDoggystyle%2CDouble%20Penetration%2CExhibitionism%2CFace%20Sitting%2CFacial%2CFemdom%2CFetish%2CFingering%2CFisting%2CFoot%20Fetish%2CFootjob%2CGangbang%2CGaping%2CGranny%2CGroup%20Sex%2CHD%2CHairy%2CHandjob%2CHidden%20Cam%2CHumiliation%2CIndian%2CInterracial%2CLactating%2CLatex%2CLesbian%2CLingerie%2CMILF%2CMassage%2CMasturbation%2CMature%2CMistress%2CMuscular%20Man%2CNon%20Nude%2CNudist%2COld%20and%20Young%2COutdoor%2CPOV%2CPakistani%2CPiercing%2CPissing%2CPregnant%2CPublic%2CRed%20Head%2CRimming%2CSecretary%2CShaved%2CShower%2CSkinny%2CSmall%20Tits%2CSmoking%2CSolo%20Female%2CSpandex%2CSpanking%2CSquirt%2CSri%20Lankan%2CStep%20Fantasy%2CStockings%2CStrapon%2CStriptease%2CSwallow%20Cum%2CSwingers%2CTattoo%2CTeacher%2CTeens%20(18%2B)%2CThreesome%2CTight%20Clothes%2CToys%2CTwerk%2CUpskirt%2CVoyeur%2CWebcam%2CWife&source=1849513610&only_hd=on&feed_format=csv&screenshot_format=source&limit=100&tag=girls&csv_separator=%7C&csv_columns=embed";
