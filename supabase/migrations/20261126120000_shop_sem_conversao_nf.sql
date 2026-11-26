-- A loja não usa mais conversão "1 da nota = X no estoque" (ex.: rolo de
-- corda = 16 encordoamentos). Toda nota entra 1 para 1. Zera a conversão
-- dos produtos que tinham, para a próxima nota não multiplicar a entrada.
-- O estoque atual não muda; só as próximas entradas.
update public.shop_products set nf_unit_factor = 1 where nf_unit_factor <> 1;
