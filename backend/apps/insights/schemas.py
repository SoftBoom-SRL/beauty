from datetime import date as date_type
from decimal import Decimal

from ninja import Schema


class ClientCategoryCount(Schema):
    category: str
    count: int


class KpisOut(Schema):
    revenue: Decimal
    sales_count: int
    avg_ticket: Decimal
    retail_revenue: Decimal
    appointments_count: int
    noshow_rate: float
    cancel_rate: float
    occupancy_pct: float
    return_rate: float
    rebooking_rate: float
    new_clients: int
    returning_clients: int
    avg_frequency: float
    clients_by_category: list[ClientCategoryCount]


class RevenuePointOut(Schema):
    date: date_type
    revenue: Decimal


class CategoryRevenueOut(Schema):
    category: str
    revenue: Decimal


class WeekdayOccupancyOut(Schema):
    weekday: int
    occupancy_pct: float


class AskIn(Schema):
    question: str
